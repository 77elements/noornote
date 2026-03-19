/**
 * FollowPackManager
 * Browse and interact with FollowPacks (Kind 39089)
 *
 * Features:
 * - Grid view of all available packs
 * - Detail view with member list
 * - "Follow All" to batch-follow pack members
 * - "See Notes" to open pack timeline
 * - "Edit List" for pack owners (Phase 2)
 *
 * @used-by MainLayout (via ListViewPartial)
 */

import { type FollowPack, parseFollowPackEvent, filterFollowPacks } from '../helpers/parseFollowPack';
import { NostrTransport } from '../services/transport/NostrTransport';
import { RelayConfig } from '../services/RelayConfig';
import { UserProfileService } from '../services/UserProfileService';
import { AuthService } from '../services/AuthService';
import { ToastService } from '../services/ToastService';
import { Router } from '../services/Router';
import { SystemLogger } from '../components/system/SystemLogger';
import { escapeHtml, escapeHtmlAttr } from '../helpers/escapeHtml';
import { hexToNpub } from '../helpers/nip19';
import { npubToUsername } from '../helpers/npubToUsername';

type ViewMode = 'grid' | 'detail' | 'timeline';

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
        <button class="follow-packs__back-btn btn btn--mini btn--secondary">&larr; Back</button>
        <h2 class="follow-packs__detail-title">${escapeHtml(pack.title)}</h2>
        ${pack.description ? `<p class="follow-packs__detail-desc">${escapeHtml(pack.description)}</p>` : ''}
        <div class="follow-packs__detail-meta">
          <span class="follow-packs__detail-author" data-pubkey="${pack.authorPubkey}">by ...</span>
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

    // Edit List (Phase 2)
    header.querySelector('.follow-packs__btn-edit')?.addEventListener('click', () => {
      ToastService.show('Edit List coming soon', 'info');
    });

    // Member list
    const memberList = document.createElement('div');
    memberList.className = 'follow-packs__members';
    memberList.innerHTML = '<div class="follow-packs__members-loading pulsate">Loading members...</div>';
    wrapper.appendChild(memberList);

    container.appendChild(wrapper);

    // Load author profile
    this.loadProfileForElement(
      pack.authorPubkey,
      header.querySelector('.follow-packs__detail-author') as HTMLElement,
      'by '
    );

    // Load member profiles
    await this.loadMembers(pack, memberList);
  }

  private async loadMembers(pack: FollowPack, memberList: HTMLElement): Promise<void> {
    const [profiles, { getFollowItems, setFollowItems }] = await Promise.all([
      this.profileService.getUserProfiles(pack.userPubkeys),
      import('./follows')
    ]);

    const followedPubkeys = new Set(getFollowItems().map(f => f.pubkey));

    memberList.innerHTML = '';

    const grid = document.createElement('div');
    grid.className = 'follow-packs__members-grid';

    pack.userPubkeys.forEach(pubkey => {
      const profile = profiles.get(pubkey);
      const npub = hexToNpub(pubkey) || '';
      const name = profile?.display_name || profile?.name || npubToUsername(npub) || npub.slice(0, 12);
      const picture = profile?.picture || '';
      const isFollowing = followedPubkeys.has(pubkey);

      const card = document.createElement('div');
      card.className = 'follow-packs__member-card';

      card.innerHTML = `
        <div class="follow-packs__member-avatar-wrap">
          <img src="${escapeHtmlAttr(picture)}" alt="" class="profile-pic profile-pic--medium" />
        </div>
        <span class="follow-packs__member-name">${escapeHtml(name)}</span>
        <button class="btn btn--mini ${isFollowing ? 'btn--passive' : ''} follow-packs__member-follow-btn"
                data-pubkey="${pubkey}">${isFollowing ? 'Unfollow' : 'Follow'}</button>
      `;

      // Avatar + name click → profile
      const avatarWrap = card.querySelector('.follow-packs__member-avatar-wrap') as HTMLElement;
      const nameEl = card.querySelector('.follow-packs__member-name') as HTMLElement;
      const navigateToProfile = () => { if (npub) Router.getInstance().navigate(`/profile/${npub}`); };
      avatarWrap?.addEventListener('click', navigateToProfile);
      nameEl?.addEventListener('click', navigateToProfile);

      // Follow button
      const followBtn = card.querySelector('.follow-packs__member-follow-btn') as HTMLButtonElement;
      followBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const currentFollows = getFollowItems();
        const alreadyFollowing = currentFollows.some(f => f.pubkey === pubkey);

        if (alreadyFollowing) {
          // Unfollow
          setFollowItems(currentFollows.filter(f => f.pubkey !== pubkey));
          followBtn.textContent = 'Follow';
          followBtn.classList.remove('btn--passive');
        } else {
          // Follow
          setFollowItems([...currentFollows, { id: pubkey, pubkey, relay: '', addedAt: Math.floor(Date.now() / 1000) }]);
          followBtn.textContent = 'Unfollow';
          followBtn.classList.add('btn--passive');
        }
      });

      grid.appendChild(card);
    });

    memberList.appendChild(grid);
  }

  private async loadProfileForElement(pubkey: string, el: HTMLElement | null, prefix: string = ''): Promise<void> {
    if (!el) return;
    const profiles = await this.profileService.getUserProfiles([pubkey]);
    const profile = profiles.get(pubkey);
    if (profile) {
      el.textContent = prefix + (profile.display_name || profile.name || el.textContent || '');
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
      const { FeedOrchestrator } = await import('../services/orchestration/FeedOrchestrator');
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

      const { NoteUI } = await import('../components/ui/NoteUI');

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
      const { getFollowItems, setFollowItems } = await import('./follows');

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
