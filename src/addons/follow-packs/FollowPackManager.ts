/**
 * FollowPackManager
 * Browse and interact with FollowPacks (Kind 39089)
 *
 * Features:
 * - Grid view of all available packs
 * - Detail view with member list (ui-list__item style)
 * - "Follow All" to batch-follow pack members
 * - "See Notes" to open pack timeline
 * - "Edit List" for pack owners
 *
 * @used-by MainLayout (via ListViewPartial)
 */

import { type FollowPack, parseFollowPackEvent, filterFollowPacks } from '../../helpers/parseFollowPack';
import { NostrTransport } from '../../services/transport/NostrTransport';
import { RelayConfig } from '../../services/RelayConfig';
import { UserProfileService } from '../../services/UserProfileService';
import { AuthService } from '../../services/AuthService';
import { ToastService } from '../../services/ToastService';
import { Router } from '../../services/Router';
import { SystemLogger } from '../../components/system/SystemLogger';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { hexToNpub } from '../../helpers/nip19';
import { npubToUsername } from '../../helpers/npubToUsername';
import { renderUserMention, setupUserMentionHandlers } from '../../helpers/UserMentionHelper';

type ViewMode = 'grid' | 'detail' | 'timeline' | 'edit';

export class FollowPackManager {
  private transport: NostrTransport;
  private profileService: UserProfileService;
  private authService: AuthService;
  private systemLogger: SystemLogger;

  private packs: FollowPack[] = [];
  private loaded = false;
  private viewMode: ViewMode = 'grid';
  private selectedPack: FollowPack | null = null;
  private currentContainer: HTMLElement | null = null;

  /** Edit state — pending changes before "Update Follow Pack" */
  private editTitle = '';
  private editDescription = '';
  private editCoverImage = '';
  private editMembers: string[] = [];

  constructor(_containerElement: HTMLElement) {
    this.transport = NostrTransport.getInstance();
    this.profileService = UserProfileService.getInstance();
    this.authService = AuthService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
  }

  // ===== Public API (called by MainLayout) =====

  public async renderListTab(container: HTMLElement): Promise<void> {
    this.currentContainer = container;
    this.viewMode = 'grid';
    this.selectedPack = null;

    if (!this.loaded) {
      container.innerHTML = '<div class="follow-packs__loading pulsate">Loading Follow Packs...</div>';
      await this.fetchPacks();
    }

    this.renderCurrentView();
  }

  // ===== Fetch =====

  private async fetchPacks(): Promise<void> {
    try {
      const relays = RelayConfig.getInstance().getAggregatorRelays();
      const events = await this.transport.fetch(
        relays,
        [{ kinds: [39089 as any], limit: 50 }],
        8000, false, 'FollowPackMgr'
      );

      this.packs = filterFollowPacks(events.map(e => parseFollowPackEvent(e)));
      this.loaded = true;

      this.systemLogger.info('FollowPacks', `Loaded ${this.packs.length} packs`);
    } catch {
      this.packs = [];
      this.loaded = true;
    }
  }

  // ===== View Router =====

  private renderCurrentView(): void {
    if (!this.currentContainer) return;

    switch (this.viewMode) {
      case 'grid':
        this.renderGrid();
        break;
      case 'detail':
        if (this.selectedPack) this.renderDetail(this.selectedPack);
        break;
      case 'timeline':
        if (this.selectedPack) this.renderTimeline(this.selectedPack);
        break;
      case 'edit':
        if (this.selectedPack) this.renderEdit(this.selectedPack);
        break;
    }
  }

  // ===== Grid View =====

  private renderGrid(): void {
    const container = this.currentContainer!;
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'follow-packs';

    const header = document.createElement('div');
    header.className = 'follow-packs__header';
    header.innerHTML = `<h2 class="follow-packs__title">Follow Packs</h2>`;
    wrapper.appendChild(header);

    if (this.packs.length === 0) {
      wrapper.innerHTML += '<div class="follow-packs__empty">No follow packs found</div>';
      container.appendChild(wrapper);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'follow-packs__grid';

    this.packs.forEach((pack, index) => {
      const card = this.createPackCard(pack, index);
      grid.appendChild(card);
    });

    wrapper.appendChild(grid);
    container.appendChild(wrapper);

    // Load author profiles in background
    this.loadAuthorProfiles();
  }

  private createPackCard(pack: FollowPack, _index: number): HTMLElement {
    const card = document.createElement('div');
    card.className = 'follow-packs__card';

    const coverHtml = pack.coverImage
      ? `<img src="${escapeHtmlAttr(pack.coverImage)}" alt="" class="follow-packs__card-cover" loading="lazy" />`
      : '<div class="follow-packs__card-cover follow-packs__card-cover--placeholder"></div>';

    card.innerHTML = `
      ${coverHtml}
      <div class="follow-packs__card-body">
        <div class="follow-packs__card-title">${escapeHtml(pack.title)}</div>
        <div class="follow-packs__card-meta">
          <span class="follow-packs__card-author" data-pubkey="${pack.authorPubkey}"></span>
          <span class="follow-packs__card-count">${pack.userPubkeys.length} people</span>
        </div>
      </div>
    `;

    // Set author name
    const authorEl = card.querySelector('.follow-packs__card-author') as HTMLElement;
    if (authorEl) {
      const npub = hexToNpub(pack.authorPubkey);
      authorEl.textContent = npub ? npubToUsername(npub) : 'Unknown';
    }

    card.addEventListener('click', () => {
      this.selectedPack = pack;
      this.viewMode = 'detail';
      this.renderCurrentView();
    });

    return card;
  }

  private async loadAuthorProfiles(): Promise<void> {
    const pubkeys = [...new Set(this.packs.map(p => p.authorPubkey))];
    const profiles = await this.profileService.getUserProfiles(pubkeys);

    // Update author names in DOM
    const authorEls = this.currentContainer?.querySelectorAll('.follow-packs__card-author[data-pubkey]');
    authorEls?.forEach(el => {
      const pubkey = (el as HTMLElement).dataset.pubkey;
      if (!pubkey) return;
      const profile = profiles.get(pubkey);
      if (profile) {
        (el as HTMLElement).textContent = profile.display_name || profile.name || (el as HTMLElement).textContent || '';
      }
    });
  }

  // ===== Detail View =====

  private async renderDetail(pack: FollowPack): Promise<void> {
    const container = this.currentContainer!;
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'follow-packs';

    const currentUser = this.authService.getCurrentUser();
    const isOwner = currentUser?.pubkey === pack.authorPubkey;

    // Header with back button
    const header = document.createElement('div');
    header.className = 'follow-packs__detail-header';

    const coverHtml = pack.coverImage
      ? `<img src="${escapeHtmlAttr(pack.coverImage)}" alt="" class="follow-packs__detail-cover" loading="lazy" />`
      : '';

    header.innerHTML = `
      ${coverHtml}
      <div class="follow-packs__detail-info">
        <div class="follow-packs__detail-title-row">
          <h2 class="follow-packs__detail-title">${escapeHtml(pack.title)}</h2>
          <button class="follow-packs__back-btn btn btn--mini btn--secondary">&larr; Back</button>
        </div>
        ${pack.description ? `<p class="follow-packs__detail-desc">${escapeHtml(pack.description)}</p>` : ''}
        <div class="follow-packs__detail-meta">
          <span class="follow-packs__detail-author-label">by </span>
          <span class="follow-packs__detail-author-mention"></span>
          <button class="follow-packs__dm-btn btn-icon" title="Send DM">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
              <polyline points="22,6 12,13 2,6"></polyline>
            </svg>
          </button>
          <span>${pack.userPubkeys.length} people</span>
        </div>
        <div class="follow-packs__detail-actions">
          <button class="btn follow-packs__btn-follow-all">Follow All</button>
          <button class="btn btn--passive follow-packs__btn-see-notes">See Notes</button>
          ${isOwner ? '<button class="btn btn--secondary follow-packs__btn-edit">Edit List</button>' : ''}
        </div>
      </div>
    `;

    wrapper.appendChild(header);

    // Back button
    header.querySelector('.follow-packs__back-btn')?.addEventListener('click', () => {
      this.viewMode = 'grid';
      this.selectedPack = null;
      this.renderCurrentView();
    });

    // Follow All
    header.querySelector('.follow-packs__btn-follow-all')?.addEventListener('click', () => {
      this.followAll(pack);
    });

    // See Notes
    header.querySelector('.follow-packs__btn-see-notes')?.addEventListener('click', () => {
      this.viewMode = 'timeline';
      this.renderCurrentView();
    });

    // Edit List
    header.querySelector('.follow-packs__btn-edit')?.addEventListener('click', () => {
      this.initEditState(pack);
      this.viewMode = 'edit';
      this.renderCurrentView();
    });

    // Member list
    const memberList = document.createElement('div');
    memberList.className = 'follow-packs__members';
    memberList.innerHTML = '<div class="follow-packs__members-loading pulsate">Loading members...</div>';
    wrapper.appendChild(memberList);

    container.appendChild(wrapper);

    // Render author as UserMention
    const authorMentionContainer = header.querySelector('.follow-packs__detail-author-mention') as HTMLElement;
    if (authorMentionContainer) {
      const profiles = await this.profileService.getUserProfiles([pack.authorPubkey]);
      const profile = profiles.get(pack.authorPubkey);
      const username = profile?.display_name || profile?.name || 'Unknown';
      const avatarUrl = profile?.picture || '';
      authorMentionContainer.innerHTML = renderUserMention(pack.authorPubkey, { username, avatarUrl });
      setupUserMentionHandlers(authorMentionContainer);
    }

    // DM button → navigate to DM conversation
    header.querySelector('.follow-packs__dm-btn')?.addEventListener('click', () => {
      const npub = hexToNpub(pack.authorPubkey);
      if (npub) Router.getInstance().navigate(`/messages/${npub}`);
    });

    // Load member profiles and render list
    await this.loadMembers(pack, memberList);
  }

  private async loadMembers(pack: FollowPack, memberList: HTMLElement): Promise<void> {
    const [profiles, { getFollowItems, setFollowItems }] = await Promise.all([
      this.profileService.getUserProfiles(pack.userPubkeys),
      import('../../lists/follows')
    ]);

    const followedPubkeys = new Set(getFollowItems().map(f => f.pubkey));

    memberList.innerHTML = '';

    const list = document.createElement('div');
    list.className = 'ui-list';

    pack.userPubkeys.forEach(pubkey => {
      const profile = profiles.get(pubkey);
      const npub = hexToNpub(pubkey) || '';
      const name = profile?.display_name || profile?.name || npubToUsername(npub) || npub.slice(0, 12);
      const picture = profile?.picture || '';
      const isFollowing = followedPubkeys.has(pubkey);

      const item = document.createElement('div');
      item.className = 'ui-list__item follow-packs__member-item';
      item.dataset.pubkey = pubkey;
      item.innerHTML = `
        <div class="follow-packs__member-content">
          <div class="follow-packs__member-avatar">
            <img class="profile-pic profile-pic--medium" src="${escapeHtmlAttr(picture)}" alt="${escapeHtmlAttr(name)}" />
          </div>
          <div class="follow-packs__member-info">
            <div class="follow-packs__member-name">${escapeHtml(name)}</div>
          </div>
        </div>
        <button class="follow-packs__member-action-btn btn ${isFollowing ? 'btn--passive ' : ''}btn--medium"
                data-pubkey="${pubkey}">${isFollowing ? 'Unfollow' : 'Follow'}</button>
      `;

      // Click content → profile
      item.querySelector('.follow-packs__member-content')?.addEventListener('click', () => {
        if (npub) Router.getInstance().navigate(`/profile/${npub}`);
      });

      // Follow/Unfollow button
      const actionBtn = item.querySelector('.follow-packs__member-action-btn') as HTMLButtonElement;
      actionBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const currentFollows = getFollowItems();
        const alreadyFollowing = currentFollows.some(f => f.pubkey === pubkey);

        if (alreadyFollowing) {
          setFollowItems(currentFollows.filter(f => f.pubkey !== pubkey));
          actionBtn.textContent = 'Follow';
          actionBtn.classList.remove('btn--passive');
        } else {
          setFollowItems([...currentFollows, { id: pubkey, pubkey, relay: '', addedAt: Math.floor(Date.now() / 1000) }]);
          actionBtn.textContent = 'Unfollow';
          actionBtn.classList.add('btn--passive');
        }
      });

      list.appendChild(item);
    });

    memberList.appendChild(list);
  }

  // ===== Edit View =====

  private initEditState(pack: FollowPack): void {
    this.editTitle = pack.title;
    this.editDescription = pack.description;
    this.editCoverImage = pack.coverImage;
    this.editMembers = [...pack.userPubkeys];
  }

  private async renderEdit(pack: FollowPack): Promise<void> {
    const container = this.currentContainer!;
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'follow-packs';

    // Header
    const header = document.createElement('div');
    header.className = 'follow-packs__edit-header';
    header.innerHTML = `
      <div class="follow-packs__detail-title-row">
        <h2 class="follow-packs__detail-title">Edit Follow Pack</h2>
        <button class="follow-packs__back-btn btn btn--mini btn--secondary">Cancel</button>
      </div>
    `;
    wrapper.appendChild(header);

    header.querySelector('.follow-packs__back-btn')?.addEventListener('click', () => {
      this.viewMode = 'detail';
      this.renderCurrentView();
    });

    // Form
    const form = document.createElement('div');
    form.className = 'follow-packs__edit-form';
    form.innerHTML = `
      <div class="follow-packs__edit-field">
        <label class="follow-packs__edit-label">List Name</label>
        <input type="text" class="input follow-packs__edit-input" data-field="title"
               value="${escapeHtmlAttr(this.editTitle)}" placeholder="Pack name" />
      </div>
      <div class="follow-packs__edit-field">
        <label class="follow-packs__edit-label">Cover Image URL</label>
        <input type="text" class="input follow-packs__edit-input" data-field="coverImage"
               value="${escapeHtmlAttr(this.editCoverImage)}" placeholder="https://..." />
      </div>
      ${this.editCoverImage ? `
        <div class="follow-packs__edit-preview">
          <img src="${escapeHtmlAttr(this.editCoverImage)}" alt="Cover preview" class="follow-packs__detail-cover" />
        </div>
      ` : ''}
      <div class="follow-packs__edit-field">
        <label class="follow-packs__edit-label">Description</label>
        <textarea class="input follow-packs__edit-textarea" data-field="description"
                  placeholder="Describe this pack..." rows="3">${escapeHtml(this.editDescription)}</textarea>
      </div>
    `;
    wrapper.appendChild(form);

    // Bind form field changes to edit state
    form.querySelectorAll('[data-field]').forEach(el => {
      el.addEventListener('input', () => {
        const field = (el as HTMLElement).dataset.field as 'title' | 'description' | 'coverImage';
        const value = (el as HTMLInputElement | HTMLTextAreaElement).value;
        if (field === 'title') this.editTitle = value;
        else if (field === 'description') this.editDescription = value;
        else if (field === 'coverImage') {
          this.editCoverImage = value;
          this.updateCoverPreview(wrapper);
        }
      });
    });

    // Add user section
    const addSection = document.createElement('div');
    addSection.className = 'follow-packs__edit-add-section';

    const addLabel = document.createElement('label');
    addLabel.className = 'follow-packs__edit-label';
    addLabel.textContent = 'Add User';
    addSection.appendChild(addLabel);

    const addRow = document.createElement('div');
    addRow.className = 'follow-packs__edit-add-row';

    const { UserSearchInput } = await import('../../components/user-search/UserSearchInput');
    const userSearch = new UserSearchInput({
      placeholder: 'Search by name or paste npub...',
      onUserSelected: () => {
        addBtn.disabled = false;
      },
      onSelectionCleared: () => {
        addBtn.disabled = true;
      }
    });
    addRow.appendChild(userSearch.getElement());

    const addBtn = document.createElement('button');
    addBtn.className = 'btn follow-packs__edit-add-btn';
    addBtn.textContent = 'Add';
    addBtn.disabled = true;
    addRow.appendChild(addBtn);

    addSection.appendChild(addRow);
    wrapper.appendChild(addSection);

    // Member list
    const membersLabel = document.createElement('label');
    membersLabel.className = 'follow-packs__edit-label';
    membersLabel.textContent = `Members (${this.editMembers.length})`;
    wrapper.appendChild(membersLabel);

    const memberList = document.createElement('div');
    memberList.className = 'follow-packs__members';
    memberList.innerHTML = '<div class="follow-packs__members-loading pulsate">Loading members...</div>';
    wrapper.appendChild(memberList);

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'follow-packs__edit-actions';
    actions.innerHTML = `
      <button class="btn follow-packs__btn-update">Update Follow Pack</button>
    `;
    wrapper.appendChild(actions);

    container.appendChild(wrapper);

    // Add button handler
    addBtn.addEventListener('click', () => {
      const pubkey = userSearch.getSelectedPubkey();
      if (!pubkey) return;

      if (this.editMembers.includes(pubkey)) {
        ToastService.show('User is already in this pack', 'info');
        userSearch.clearSelection();
        addBtn.disabled = true;
        return;
      }

      this.editMembers.push(pubkey);
      userSearch.clearSelection();
      addBtn.disabled = true;
      this.renderEditMembers(memberList, membersLabel);
    });

    // Update button handler
    actions.querySelector('.follow-packs__btn-update')?.addEventListener('click', async () => {
      await this.publishPackUpdate(pack, actions);
    });

    // Load members
    await this.renderEditMembers(memberList, membersLabel);
  }

  private updateCoverPreview(wrapper: HTMLElement): void {
    const existing = wrapper.querySelector('.follow-packs__edit-preview');
    if (this.editCoverImage) {
      if (existing) {
        (existing.querySelector('img') as HTMLImageElement).src = this.editCoverImage;
      } else {
        const preview = document.createElement('div');
        preview.className = 'follow-packs__edit-preview';
        preview.innerHTML = `<img src="${escapeHtmlAttr(this.editCoverImage)}" alt="Cover preview" class="follow-packs__detail-cover" />`;
        const coverField = wrapper.querySelector('[data-field="coverImage"]')?.closest('.follow-packs__edit-field');
        coverField?.after(preview);
      }
    } else if (existing) {
      existing.remove();
    }
  }

  private async renderEditMembers(memberList: HTMLElement, membersLabel: HTMLElement): Promise<void> {
    membersLabel.textContent = `Members (${this.editMembers.length})`;

    if (this.editMembers.length === 0) {
      memberList.innerHTML = '<div class="follow-packs__empty">No members yet</div>';
      return;
    }

    const profiles = await this.profileService.getUserProfiles(this.editMembers);

    memberList.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'ui-list';

    this.editMembers.forEach(pubkey => {
      const profile = profiles.get(pubkey);
      const npub = hexToNpub(pubkey) || '';
      const name = profile?.display_name || profile?.name || npubToUsername(npub) || npub.slice(0, 12);
      const picture = profile?.picture || '';

      const item = document.createElement('div');
      item.className = 'ui-list__item follow-packs__member-item';
      item.dataset.pubkey = pubkey;
      item.innerHTML = `
        <div class="follow-packs__member-content">
          <div class="follow-packs__member-avatar">
            <img class="profile-pic profile-pic--medium" src="${escapeHtmlAttr(picture)}" alt="${escapeHtmlAttr(name)}" />
          </div>
          <div class="follow-packs__member-info">
            <div class="follow-packs__member-name">${escapeHtml(name)}</div>
          </div>
        </div>
        <button class="follow-packs__member-action-btn btn btn--passive btn--medium"
                data-pubkey="${pubkey}">Remove</button>
      `;

      // Click content → profile
      item.querySelector('.follow-packs__member-content')?.addEventListener('click', () => {
        if (npub) Router.getInstance().navigate(`/profile/${npub}`);
      });

      // Remove button
      item.querySelector('.follow-packs__member-action-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.editMembers = this.editMembers.filter(pk => pk !== pubkey);
        item.remove();
        membersLabel.textContent = `Members (${this.editMembers.length})`;
      });

      list.appendChild(item);
    });

    memberList.appendChild(list);
  }

  private async publishPackUpdate(pack: FollowPack, actionsContainer: HTMLElement): Promise<void> {
    const updateBtn = actionsContainer.querySelector('.follow-packs__btn-update') as HTMLButtonElement;
    if (!updateBtn) return;

    if (!this.editTitle.trim()) {
      ToastService.show('Pack name is required', 'error');
      return;
    }

    updateBtn.disabled = true;
    updateBtn.textContent = 'Publishing...';

    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        ToastService.show('Not logged in', 'error');
        return;
      }

      const tags: string[][] = [
        ['d', pack.id],
        ['title', this.editTitle.trim()],
      ];

      if (this.editDescription.trim()) {
        tags.push(['description', this.editDescription.trim()]);
      }

      if (this.editCoverImage.trim()) {
        tags.push(['image', this.editCoverImage.trim()]);
      }

      // Add all members as p-tags
      this.editMembers.forEach(pubkey => {
        tags.push(['p', pubkey]);
      });

      const unsignedEvent = {
        kind: 39089,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: '',
        pubkey: currentUser.pubkey
      };

      const signedEvent = await this.authService.signEvent(unsignedEvent);
      if (!signedEvent) {
        ToastService.show('Failed to sign event', 'error');
        updateBtn.disabled = false;
        updateBtn.textContent = 'Update Follow Pack';
        return;
      }

      const writeRelays = RelayConfig.getInstance().getWriteRelays();
      const aggregatorRelays = RelayConfig.getInstance().getAggregatorRelays();
      const publishRelays = [...new Set([...writeRelays, ...aggregatorRelays])];

      await this.transport.publish(publishRelays, signedEvent);

      // Update local pack data
      pack.title = this.editTitle.trim();
      pack.description = this.editDescription.trim();
      pack.coverImage = this.editCoverImage.trim();
      pack.userPubkeys = [...this.editMembers];

      ToastService.show('Follow Pack updated', 'success');
      this.systemLogger.info('FollowPacks', `Updated pack "${pack.title}" with ${pack.userPubkeys.length} members`);

      // Go back to detail view
      this.viewMode = 'detail';
      this.renderCurrentView();
    } catch (error) {
      ToastService.show('Failed to update pack', 'error');
      this.systemLogger.error('FollowPacks', `Pack update failed: ${error}`);
      updateBtn.disabled = false;
      updateBtn.textContent = 'Update Follow Pack';
    }
  }

  // ===== Timeline View =====

  private async renderTimeline(pack: FollowPack): Promise<void> {
    const container = this.currentContainer!;
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'follow-packs follow-packs__timeline';

    // Header
    const header = document.createElement('div');
    header.className = 'follow-packs__timeline-header';
    header.innerHTML = `
      <button class="follow-packs__back-btn btn btn--mini btn--secondary">&larr; Back</button>
      <h2 class="follow-packs__title">${escapeHtml(pack.title)}</h2>
    `;
    wrapper.appendChild(header);

    header.querySelector('.follow-packs__back-btn')?.addEventListener('click', () => {
      this.viewMode = 'detail';
      this.renderCurrentView();
    });

    // Timeline container
    const timelineContainer = document.createElement('div');
    timelineContainer.className = 'follow-packs__timeline-content';
    timelineContainer.innerHTML = '<div class="pulsate">Loading notes...</div>';
    wrapper.appendChild(timelineContainer);

    container.appendChild(wrapper);

    // Load timeline
    try {
      const { FeedOrchestrator } = await import('../../services/orchestration/FeedOrchestrator');
      const feedOrch = FeedOrchestrator.getInstance();

      const result = await feedOrch.loadInitialFeed({
        followingPubkeys: pack.userPubkeys,
        includeReplies: false,
        timeWindowHours: 24
      });

      timelineContainer.innerHTML = '';

      if (result.events.length === 0) {
        timelineContainer.innerHTML = '<div class="follow-packs__empty">No recent notes from this pack</div>';
        return;
      }

      const { NoteUI } = await import('../../components/ui/NoteUI');

      result.events.forEach(event => {
        const noteEl = NoteUI.createNoteElement(event, {
          collapsible: true,
          islFetchStats: true,
          isLoggedIn: !!this.authService.getCurrentUser(),
          depth: 0
        });
        timelineContainer.appendChild(noteEl);
      });

      this.systemLogger.info('FollowPacks', `Timeline: ${result.events.length} notes for "${pack.title}"`);
    } catch (error) {
      timelineContainer.innerHTML = '<div class="follow-packs__empty">Failed to load notes</div>';
      this.systemLogger.error('FollowPacks', `Timeline load failed: ${error}`);
    }
  }

  // ===== Follow All =====

  private async followAll(pack: FollowPack): Promise<void> {
    try {
      const { getFollowItems, setFollowItems } = await import('../../lists/follows');

      const currentFollows = getFollowItems();
      const currentPubkeys = new Set(currentFollows.map(f => f.pubkey));

      const newPubkeys = pack.userPubkeys.filter(pk => !currentPubkeys.has(pk));

      if (newPubkeys.length === 0) {
        ToastService.show('You already follow everyone in this pack', 'info');
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      const newItems = newPubkeys.map(pubkey => ({
        id: pubkey,
        pubkey,
        relay: '',
        addedAt: now
      }));

      setFollowItems([...currentFollows, ...newItems]);

      ToastService.show(`Added ${newPubkeys.length} people to your follows`, 'success');
      this.systemLogger.info('FollowPacks', `Follow All: added ${newPubkeys.length} from "${pack.title}"`);
    } catch (error) {
      ToastService.show('Failed to follow pack members', 'error');
      this.systemLogger.error('FollowPacks', `Follow All failed: ${error}`);
    }
  }
}
