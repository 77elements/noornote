/**
 * FollowPackManager
 * Browse and interact with FollowPacks (Kind 39089)
 *
 * Features:
 * - Grid view of all available packs with "Create" CTA
 * - Detail view with member list
 * - "Follow All" to batch-follow pack members
 * - "See Notes" to open pack timeline
 * - "Edit List" / "Create New Follow Pack" share the same form
 *
 * @used-by MainLayout (via ListViewPartial)
 */

import {
  type FollowPack,
  parseFollowPackEvent,
  filterFollowPacks,
} from '../../helpers/parseFollowPack';
import { NostrTransport } from '../../services/transport/NostrTransport';
import { RelayConfig } from '../../services/RelayConfig';
import { UserProfileService } from '../../services/UserProfileService';
import { AuthService } from '../../services/AuthService';
import { ToastService } from '../../services/ToastService';
import { Router } from '../../services/Router';
import { SystemLogger } from '../../services/SystemLogger';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { hexToNpub } from '../../helpers/nip19';
import { npubToUsername } from '../../helpers/npubToUsername';
import {
  renderUserMention,
  setupUserMentionHandlers,
} from '../../helpers/UserMentionHelper';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { MediaModuleApi } from '../../modules/media/contracts';
import { renderFollowPackMembers } from '../../components/follow-packs/renderFollowPackMembers';

type ViewMode = 'grid' | 'detail' | 'timeline' | 'edit' | 'create';

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

  /** Edit/Create state — pending changes before publish */
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
      container.innerHTML =
        '<div class="follow-packs__loading pulsate">Loading Follow Packs...</div>';
      await this.fetchPacks();
    }

    this.renderCurrentView();
  }

  /**
   * Open a specific pack in a given view mode (called externally via EventBus)
   */
  public async openPackView(
    container: HTMLElement,
    packId: string,
    mode: 'timeline' | 'edit'
  ): Promise<void> {
    this.currentContainer = container;

    if (!this.loaded) {
      container.innerHTML =
        '<div class="follow-packs__loading pulsate">Loading Follow Packs...</div>';
      await this.fetchPacks();
    }

    const pack = this.packs.find(p => p.id === packId);
    if (!pack) {
      container.innerHTML =
        '<div class="follow-packs__loading">Pack not found</div>';
      return;
    }

    this.selectedPack = pack;
    this.viewMode = mode;
    if (mode === 'edit') this.initEditState(pack);
    this.renderCurrentView();
  }

  // ===== Fetch =====

  private async fetchPacks(): Promise<void> {
    try {
      const relays = RelayConfig.getInstance().getAggregatorRelays();
      const events = await this.transport.fetch(
        relays,
        [{ kinds: [39089], limit: 50 }],
        8000,
        false,
        'FollowPackMgr'
      );

      this.packs = filterFollowPacks(events.map(e => parseFollowPackEvent(e)));
      this.loaded = true;

      this.systemLogger.info(
        'FollowPacks',
        `Loaded ${this.packs.length} packs`
      );
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
        if (this.selectedPack) void this.renderDetail(this.selectedPack);
        break;
      case 'timeline':
        if (this.selectedPack) void this.renderTimeline(this.selectedPack);
        break;
      case 'edit':
        if (this.selectedPack)
          void this.renderPackForm('edit', this.selectedPack);
        break;
      case 'create':
        void this.renderPackForm('create', null);
        break;
    }
  }

  // ===== Grid View =====

  private renderGrid(): void {
    const container = this.currentContainer!;
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'follow-packs';

    // Teaser + Create button (only if logged in)
    const currentUser = this.authService.getCurrentUser();
    if (currentUser) {
      const teaser = document.createElement('div');
      teaser.className = 'follow-packs__teaser';
      teaser.innerHTML = `
        <button class="btn follow-packs__btn-create">Create New Follow Pack</button>
      `;
      wrapper.appendChild(teaser);

      teaser
        .querySelector('.follow-packs__btn-create')
        ?.addEventListener('click', () => {
          this.initCreateState();
          this.viewMode = 'create';
          this.renderCurrentView();
        });
    }

    if (this.packs.length === 0) {
      wrapper.innerHTML +=
        '<div class="follow-packs__empty">No follow packs found</div>';
      container.appendChild(wrapper);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'follow-packs__grid nn-card-grid';

    this.packs.forEach((pack, index) => {
      const card = this.createPackCard(pack, index);
      grid.appendChild(card);
    });

    wrapper.appendChild(grid);
    container.appendChild(wrapper);

    // Load author profiles in background
    void this.loadAuthorProfiles();
  }

  private createPackCard(pack: FollowPack, _index: number): HTMLElement {
    const card = document.createElement('div');
    card.className = 'nn-card';

    const coverHtml = pack.coverImage
      ? `<div class="nn-card__media"><img src="${escapeHtmlAttr(pack.coverImage)}" alt="" loading="lazy" /></div>`
      : '<div class="nn-card__media nn-card__media--empty"></div>';

    card.innerHTML = `
      ${coverHtml}
      <div class="nn-card__content">
        <h3>${escapeHtml(pack.title)}</h3>
        <div class="meta">
          <span class="author" data-pubkey="${pack.authorPubkey}"></span>
          <span>${pack.userPubkeys.length} people</span>
        </div>
      </div>
    `;

    // Set author name
    const authorEl = card.querySelector('.author') as HTMLElement;
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
    const authorEls = this.currentContainer?.querySelectorAll(
      '.author[data-pubkey]'
    );
    authorEls?.forEach(el => {
      const pubkey = (el as HTMLElement).dataset.pubkey;
      if (!pubkey) return;
      const profile = profiles.get(pubkey);
      if (profile) {
        (el as HTMLElement).textContent =
          profile.display_name ||
          profile.name ||
          (el as HTMLElement).textContent ||
          '';
      }
    });
  }

  // ===== Detail View =====

  private async renderDetail(pack: FollowPack): Promise<void> {
    const container = this.currentContainer!;
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'follow-packs';

    const isOwner = this.authService.isCurrentUser(pack.authorPubkey);

    // Header with back button
    const header = document.createElement('div');
    header.className = 'follow-packs__detail-header';

    const coverHtml = pack.coverImage
      ? `<img src="${escapeHtmlAttr(pack.coverImage)}" alt="" class="follow-packs__detail-cover" loading="lazy" />`
      : '';

    header.innerHTML = `
      ${coverHtml}
      <div class="follow-packs__detail-info">
        <div class="l-spread">
          <h2 class="follow-packs__detail-title">${escapeHtml(pack.title)}</h2>
          <button class="follow-packs__back-btn btn btn--medium btn--passive">&larr; Back</button>
        </div>
        ${pack.description ? `<p class="follow-packs__detail-desc">${escapeHtml(pack.description)}</p>` : ''}
        <div class="follow-packs__detail-meta">
          <span class="follow-packs__detail-author-label">by </span>
          <span class="follow-packs__detail-author-mention"></span>
          <button class="follow-packs__dm-btn btn-icon" title="Send DM">
            <svg width="16" height="16"><use href="#icon-email"/></svg>
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
    header
      .querySelector('.follow-packs__back-btn')
      ?.addEventListener('click', () => {
        this.viewMode = 'grid';
        this.selectedPack = null;
        this.renderCurrentView();
      });

    // Follow All
    header
      .querySelector('.follow-packs__btn-follow-all')
      ?.addEventListener('click', () => {
        void this.followAll(pack);
      });

    // See Notes
    header
      .querySelector('.follow-packs__btn-see-notes')
      ?.addEventListener('click', () => {
        this.viewMode = 'timeline';
        this.renderCurrentView();
      });

    // Edit List
    header
      .querySelector('.follow-packs__btn-edit')
      ?.addEventListener('click', () => {
        this.initEditState(pack);
        this.viewMode = 'edit';
        this.renderCurrentView();
      });

    // Member list
    const memberList = document.createElement('div');
    memberList.className = 'follow-packs__members';
    memberList.innerHTML =
      '<div class="follow-packs__members-loading pulsate">Loading members...</div>';
    wrapper.appendChild(memberList);

    container.appendChild(wrapper);

    // Render author as UserMention
    const authorMentionContainer = header.querySelector(
      '.follow-packs__detail-author-mention'
    ) as HTMLElement;
    if (authorMentionContainer) {
      const profiles = await this.profileService.getUserProfiles([
        pack.authorPubkey,
      ]);
      const profile = profiles.get(pack.authorPubkey);
      const username = profile?.display_name || profile?.name || 'Unknown';
      const avatarUrl = profile?.picture || '';
      authorMentionContainer.innerHTML = renderUserMention(pack.authorPubkey, {
        username,
        avatarUrl,
      });
      setupUserMentionHandlers(authorMentionContainer);
    }

    // DM button → navigate to DM conversation
    header
      .querySelector('.follow-packs__dm-btn')
      ?.addEventListener('click', () => {
        const npub = hexToNpub(pack.authorPubkey);
        if (npub) Router.getInstance().navigate(`/messages/${npub}`);
      });

    // Load member profiles and render list
    await this.loadMembers(pack, memberList);
  }

  private async loadMembers(
    pack: FollowPack,
    memberList: HTMLElement
  ): Promise<void> {
    await renderFollowPackMembers(pack, memberList);
  }

  // ===== Create / Edit Form (shared) =====

  private initEditState(pack: FollowPack): void {
    this.editTitle = pack.title;
    this.editDescription = pack.description;
    this.editCoverImage = pack.coverImage;
    this.editMembers = [...pack.userPubkeys];
  }

  private initCreateState(): void {
    this.editTitle = '';
    this.editDescription = '';
    this.editCoverImage = '';
    this.editMembers = [];
  }

  /**
   * Shared form for Create and Edit.
   * @param mode 'create' or 'edit'
   * @param pack existing pack (edit) or null (create)
   */
  private async renderPackForm(
    mode: 'create' | 'edit',
    pack: FollowPack | null
  ): Promise<void> {
    const container = this.currentContainer!;
    container.innerHTML = '';

    const isCreate = mode === 'create';
    const heading = isCreate ? 'Create Follow Pack' : 'Edit Follow Pack';
    const publishLabel = isCreate
      ? 'Publish Follow Pack'
      : 'Update Follow Pack';
    const cancelTarget = isCreate ? 'grid' : 'detail';

    const wrapper = document.createElement('div');
    wrapper.className = 'follow-packs';

    // Header
    const header = document.createElement('div');
    header.className = 'follow-packs__edit-header';
    header.innerHTML = `
      <div class="l-spread">
        <h2 class="follow-packs__detail-title">${heading}</h2>
        <button class="follow-packs__back-btn btn btn--medium btn--passive">Cancel</button>
      </div>
    `;
    wrapper.appendChild(header);

    header
      .querySelector('.follow-packs__back-btn')
      ?.addEventListener('click', () => {
        this.viewMode = cancelTarget as ViewMode;
        this.renderCurrentView();
      });

    // Form fields
    const form = document.createElement('div');
    form.className = 'follow-packs__edit-form';
    form.innerHTML = `
      <div class="form__row">
        <label>List Name</label>
        <input type="text" class="input" data-field="title"
               value="${escapeHtmlAttr(this.editTitle)}" placeholder="e.g. Nostr Developers to Follow" />
      </div>
      <div class="form__row">
        <label>Cover Image</label>
        <div class="follow-packs__edit-add-row">
          <input type="text" class="input" data-field="coverImage"
                 value="${escapeHtmlAttr(this.editCoverImage)}" placeholder="https://..." />
          <input type="file" accept="image/*" style="display:none" data-cover-file-input />
          <button type="button" class="btn btn--secondary follow-packs__edit-add-btn" data-cover-upload title="Upload image">
            <svg width="16" height="16"><use href="#icon-upload"/></svg>
          </button>
        </div>
      </div>
      ${
        this.editCoverImage
          ? `
        <div class="follow-packs__edit-preview">
          <img src="${escapeHtmlAttr(this.editCoverImage)}" alt="Cover preview" class="follow-packs__detail-cover" />
        </div>
      `
          : ''
      }
      <div class="form__row">
        <label>Description</label>
        <textarea class="textarea" data-field="description"
                  placeholder="A description for this follow list..." rows="3">${escapeHtml(this.editDescription)}</textarea>
      </div>
    `;
    wrapper.appendChild(form);

    // Bind form field changes to edit state
    form.querySelectorAll('[data-field]').forEach(el => {
      el.addEventListener('input', () => {
        const field = (el as HTMLElement).dataset.field as
          | 'title'
          | 'description'
          | 'coverImage';
        const value = (el as HTMLInputElement | HTMLTextAreaElement).value;
        if (field === 'title') this.editTitle = value;
        else if (field === 'description') this.editDescription = value;
        else if (field === 'coverImage') {
          this.editCoverImage = value;
          this.updateCoverPreview(wrapper);
        }
      });
    });

    // Cover image upload button
    const coverUploadBtn = form.querySelector(
      '[data-cover-upload]'
    ) as HTMLButtonElement;
    const coverFileInput = form.querySelector(
      '[data-cover-file-input]'
    ) as HTMLInputElement;
    const coverInput = form.querySelector(
      '[data-field="coverImage"]'
    ) as HTMLInputElement;
    if (coverUploadBtn && coverFileInput && coverInput) {
      coverUploadBtn.addEventListener('click', () => coverFileInput.click());
      coverFileInput.addEventListener('change', async () => {
        const file = coverFileInput.files?.[0];
        if (!file) return;
        coverUploadBtn.disabled = true;
        const originalHTML = coverUploadBtn.innerHTML;
        coverUploadBtn.textContent = '...';
        try {
          const mediaApi =
            ModuleLoader.getInstance().getApi<MediaModuleApi>('media');
          if (!mediaApi) {
            ToastService.show('Media module not available', 'error');
            return;
          }
          const result = await mediaApi.uploadFile(file);
          if (result.success && result.url) {
            coverInput.value = result.url;
            this.editCoverImage = result.url;
            this.updateCoverPreview(wrapper);
          }
        } catch {
          ToastService.show('Failed to upload image', 'error');
        }
        coverUploadBtn.disabled = false;
        coverUploadBtn.innerHTML = originalHTML;
        coverFileInput.value = '';
      });
    }

    // Add user section
    const addSection = document.createElement('div');
    addSection.className = 'form__row';

    const addLabel = document.createElement('label');
    addLabel.textContent = 'Add User';
    addSection.appendChild(addLabel);

    const addRow = document.createElement('div');
    addRow.className = 'follow-packs__edit-add-row';

    const { UserSearchInput } = await import(
      '../../components/user-search/UserSearchInput'
    );
    const userSearch = new UserSearchInput({
      placeholder: 'Search by name or paste npub...',
      onUserSelected: () => {
        addBtn.disabled = false;
      },
      onSelectionCleared: () => {
        addBtn.disabled = true;
      },
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
    const membersLabel = document.createElement('h3');
    membersLabel.textContent = `Members (${this.editMembers.length})`;
    wrapper.appendChild(membersLabel);

    const memberList = document.createElement('div');
    memberList.className = 'follow-packs__members';
    if (this.editMembers.length === 0) {
      memberList.innerHTML =
        '<div class="follow-packs__empty">No members yet</div>';
    } else {
      memberList.innerHTML =
        '<div class="follow-packs__members-loading pulsate">Loading members...</div>';
    }
    wrapper.appendChild(memberList);

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'follow-packs__edit-actions';
    actions.innerHTML = `
      <button class="btn follow-packs__btn-publish">${publishLabel}</button>
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
      void this.renderEditMembers(memberList, membersLabel);
    });

    // Publish button handler
    actions
      .querySelector('.follow-packs__btn-publish')
      ?.addEventListener('click', async () => {
        await this.publishPack(mode, pack, actions);
      });

    // Load existing members (if any)
    if (this.editMembers.length > 0) {
      await this.renderEditMembers(memberList, membersLabel);
    }
  }

  private updateCoverPreview(wrapper: HTMLElement): void {
    const existing = wrapper.querySelector('.follow-packs__edit-preview');
    if (this.editCoverImage) {
      if (existing) {
        (existing.querySelector('img') as HTMLImageElement).src =
          this.editCoverImage;
      } else {
        const preview = document.createElement('div');
        preview.className = 'follow-packs__edit-preview';
        preview.innerHTML = `<img src="${escapeHtmlAttr(this.editCoverImage)}" alt="Cover preview" class="follow-packs__detail-cover" />`;
        const coverField = wrapper
          .querySelector('[data-field="coverImage"]')
          ?.closest('.form__row');
        coverField?.after(preview);
      }
    } else if (existing) {
      existing.remove();
    }
  }

  private async renderEditMembers(
    memberList: HTMLElement,
    membersLabel: HTMLElement
  ): Promise<void> {
    membersLabel.textContent = `Members (${this.editMembers.length})`;

    if (this.editMembers.length === 0) {
      memberList.innerHTML =
        '<div class="follow-packs__empty">No members yet</div>';
      return;
    }

    const profiles = await this.profileService.getUserProfiles(
      this.editMembers
    );

    memberList.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'ui-list';

    this.editMembers.forEach(pubkey => {
      const profile = profiles.get(pubkey);
      const npub = hexToNpub(pubkey) || '';
      const name =
        profile?.display_name ||
        profile?.name ||
        npubToUsername(npub) ||
        npub.slice(0, 12);
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
      item
        .querySelector('.follow-packs__member-content')
        ?.addEventListener('click', () => {
          if (npub) Router.getInstance().navigate(`/profile/${npub}`);
        });

      // Remove button
      item
        .querySelector('.follow-packs__member-action-btn')
        ?.addEventListener('click', e => {
          e.stopPropagation();
          this.editMembers = this.editMembers.filter(pk => pk !== pubkey);
          item.remove();
          membersLabel.textContent = `Members (${this.editMembers.length})`;
        });

      list.appendChild(item);
    });

    memberList.appendChild(list);
  }

  /**
   * Publish a new pack (create) or update an existing one (edit).
   * Create generates a new d-tag, edit reuses the existing one.
   */
  private async publishPack(
    mode: 'create' | 'edit',
    pack: FollowPack | null,
    actionsContainer: HTMLElement
  ): Promise<void> {
    const publishBtn = actionsContainer.querySelector(
      '.follow-packs__btn-publish'
    ) as HTMLButtonElement;
    if (!publishBtn) return;

    if (!this.editTitle.trim()) {
      ToastService.show('Pack name is required', 'error');
      return;
    }

    publishBtn.disabled = true;
    publishBtn.textContent = 'Publishing...';

    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        ToastService.show('Not logged in', 'error');
        return;
      }

      // d-tag: reuse for edit, generate for create
      const dTag =
        mode === 'edit' && pack
          ? pack.id
          : `${this.editTitle
              .trim()
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .slice(0, 30)}-${Math.random().toString(36).slice(2, 8)}`;

      const tags: string[][] = [
        ['d', dTag],
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
        pubkey: currentUser.pubkey,
      };

      const signedEvent = await this.authService.signEvent(unsignedEvent);
      if (!signedEvent) {
        ToastService.show('Failed to sign event', 'error');
        publishBtn.disabled = false;
        publishBtn.textContent =
          mode === 'create' ? 'Publish Follow Pack' : 'Update Follow Pack';
        return;
      }

      const writeRelays = RelayConfig.getInstance().getWriteRelays();
      const aggregatorRelays = RelayConfig.getInstance().getAggregatorRelays();
      const publishRelays = [...new Set([...writeRelays, ...aggregatorRelays])];

      await this.transport.publish(publishRelays, signedEvent);

      if (mode === 'edit' && pack) {
        // Update local pack data
        pack.title = this.editTitle.trim();
        pack.description = this.editDescription.trim();
        pack.coverImage = this.editCoverImage.trim();
        pack.userPubkeys = [...this.editMembers];

        ToastService.show('Follow Pack updated', 'success');
        this.systemLogger.info(
          'FollowPacks',
          `Updated pack "${pack.title}" with ${pack.userPubkeys.length} members`
        );

        this.viewMode = 'detail';
      } else {
        // Add to local packs list
        const newPack: FollowPack = {
          id: dTag,
          eventId: signedEvent.id || '',
          title: this.editTitle.trim(),
          description: this.editDescription.trim(),
          coverImage: this.editCoverImage.trim(),
          authorPubkey: currentUser.pubkey,
          createdAt: Math.floor(Date.now() / 1000),
          userPubkeys: [...this.editMembers],
        };
        this.packs.unshift(newPack);

        ToastService.show('Follow Pack published', 'success');
        this.systemLogger.info(
          'FollowPacks',
          `Created pack "${newPack.title}" with ${newPack.userPubkeys.length} members`
        );

        this.selectedPack = newPack;
        this.viewMode = 'detail';
      }

      this.renderCurrentView();
    } catch (error) {
      ToastService.show('Failed to publish pack', 'error');
      this.systemLogger.error(
        'FollowPacks',
        `Pack publish failed: ${String(error)}`
      );
      publishBtn.disabled = false;
      publishBtn.textContent =
        mode === 'create' ? 'Publish Follow Pack' : 'Update Follow Pack';
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
    header.className = 'l-spread follow-packs__section-header';
    header.innerHTML = `
      <h2>${escapeHtml(pack.title)}</h2>
      <button class="follow-packs__back-btn btn btn--medium btn--passive">&larr; Back</button>
    `;
    wrapper.appendChild(header);

    header
      .querySelector('.follow-packs__back-btn')
      ?.addEventListener('click', () => {
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
      const timelineApi =
        ModuleLoader.getInstance().getApi<
          import('../../modules/timeline/contracts').TimelineModuleApi
        >('timeline');

      const result = (await timelineApi?.loadInitialFeed({
        followingPubkeys: pack.userPubkeys,
        includeReplies: false,
        timeWindowHours: 24,
      })) ?? { events: [], hasMore: false };

      timelineContainer.innerHTML = '';

      if (result.events.length === 0) {
        timelineContainer.innerHTML =
          '<div class="follow-packs__empty">No recent notes from this pack</div>';
        return;
      }

      const { NoteUI } = await import('../../components/ui/NoteUI');

      result.events.forEach(event => {
        const noteEl = NoteUI.createNoteElement(event, {
          collapsible: true,
          islFetchStats: true,
          isLoggedIn: !!this.authService.getCurrentUser(),
          depth: 0,
        });
        timelineContainer.appendChild(noteEl);
      });

      this.systemLogger.info(
        'FollowPacks',
        `Timeline: ${result.events.length} notes for "${pack.title}"`
      );
    } catch (error) {
      timelineContainer.innerHTML =
        '<div class="follow-packs__empty">Failed to load notes</div>';
      this.systemLogger.error(
        'FollowPacks',
        `Timeline load failed: ${String(error)}`
      );
    }
  }

  // ===== Follow All =====

  private async followAll(pack: FollowPack): Promise<void> {
    try {
      const { getFollowItems, setFollowItems } = await import(
        '../../lists/follows'
      );

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
        addedAt: now,
      }));

      setFollowItems([...currentFollows, ...newItems]);

      ToastService.show(
        `Added ${newPubkeys.length} people to your follows`,
        'success'
      );
      this.systemLogger.info(
        'FollowPacks',
        `Follow All: added ${newPubkeys.length} from "${pack.title}"`
      );
    } catch (error) {
      ToastService.show('Failed to follow pack members', 'error');
      this.systemLogger.error(
        'FollowPacks',
        `Follow All failed: ${String(error)}`
      );
    }
  }
}
