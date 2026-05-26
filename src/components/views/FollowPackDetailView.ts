/**
 * FollowPackDetailView - Standalone view for a Follow Pack (kind 39089)
 * Loaded via /follow-pack/:naddr route.
 * Shows pack details, member list, ISL, and replies.
 */

import { View } from './View';
import { Router } from '../../services/Router';
import { AuthService } from '../../services/AuthService';
import { NostrTransport } from '../../services/transport/NostrTransport';
import { UserProfileService } from '../../services/UserProfileService';
import { SystemLogger } from '../../services/SystemLogger';
import { TypedEventBus } from '../../core/TypedEventBus';
import { InteractionStatusLine } from '../ui/InteractionStatusLine';
import { RepliesRenderer } from '../replies/RepliesRenderer';
import { NoteHeader } from '../ui/NoteHeader';
import { decodeNip19 } from '../../services/NostrToolsAdapter';
import { hexToNpub } from '../../helpers/nip19';
import { parseFollowPackEvent, type FollowPack } from '../../helpers/parseFollowPack';
import { renderFollowPackMembers } from '../follow-packs/renderFollowPackMembers';
import { getAddressableIdentifier } from '../../helpers/getAddressableIdentifier';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { renderUserMention, setupUserMentionHandlers } from '../../helpers/UserMentionHelper';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { FollowItem } from '../../lists/follows';

export class FollowPackDetailView extends View {
  private container: HTMLElement;
  private naddrRef: string;
  private router: Router;
  private systemLogger: SystemLogger;

  constructor(naddrRef: string) {
    super();
    this.naddrRef = naddrRef;
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--follow-pack';
    this.router = Router.getInstance();
    this.systemLogger = SystemLogger.getInstance();

    this.render();
  }

  private async render(): Promise<void> {
    this.container.innerHTML = `
      <div class="article-view-loading">
        <div class="loading-spinner"></div>
        <p>Loading follow pack...</p>
      </div>
    `;

    try {
      const event = await this.fetchEvent();
      if (!event) {
        this.container.innerHTML = '<div class="article-view-error"><p>Follow pack not found</p></div>';
        return;
      }

      this.renderPack(event);
    } catch (error) {
      this.systemLogger.error('FollowPackDetailView', `Failed to load: ${error}`);
      this.container.innerHTML = '<div class="article-view-error"><p>Failed to load follow pack</p></div>';
    }
  }

  private async fetchEvent(): Promise<NostrEvent | null> {
    const decoded = decodeNip19(this.naddrRef);
    if (decoded.type !== 'naddr') return null;

    const data = decoded.data as { kind: number; pubkey: string; identifier: string; relays?: string[] };
    const transport = NostrTransport.getInstance();
    const relays = data.relays?.length ? data.relays : transport.getReadRelays();

    const events = await transport.fetch(relays, [{
      kinds: [data.kind],
      authors: [data.pubkey],
      '#d': [data.identifier],
      limit: 1
    }], 8000, false, 'FollowPackDetail');

    return events[0] || null;
  }

  private async renderPack(event: NostrEvent): Promise<void> {
    const pack = parseFollowPackEvent(event);
    const currentUser = AuthService.getInstance().getCurrentUser();
    const isOwner = AuthService.getInstance().isCurrentUser(pack.authorPubkey);
    const isLoggedIn = currentUser !== null;

    const coverHtml = pack.coverImage
      ? `<img src="${escapeHtmlAttr(pack.coverImage)}" alt="" class="follow-packs__detail-cover" loading="lazy" />`
      : '';

    this.container.innerHTML = `
      <div class="follow-packs">
        <div class="follow-packs__detail-header">
          ${coverHtml}
          <div class="follow-packs__detail-info">
            <div class="l-spread">
              <h2 class="follow-packs__detail-title">${escapeHtml(pack.title)}</h2>
            </div>
            ${pack.description ? `<p class="follow-packs__detail-desc">${escapeHtml(pack.description)}</p>` : ''}
            <div class="follow-packs__detail-meta">
              <span class="follow-packs__detail-author-label">by </span>
              <span class="follow-packs__detail-author-mention"></span>
              ${isLoggedIn ? `<button class="follow-packs__dm-btn btn-icon" title="Send DM">
                <svg width="16" height="16"><use href="#icon-email"/></svg>
              </button>` : ''}
              <span>${pack.userPubkeys.length} people</span>
            </div>
            <div class="follow-packs__detail-actions">
              ${isLoggedIn ? '<button class="btn follow-packs__btn-follow-all">Follow All</button>' : ''}
            </div>
          </div>
        </div>
        <div class="follow-packs__detail-author-header"></div>
        <div class="follow-packs__detail-isl"></div>
        <div class="follow-packs__members">
          <div class="follow-packs__members-loading pulsate">Loading members...</div>
        </div>
        <div class="follow-packs__detail-replies"></div>
      </div>
    `;

    // Author header (NoteHeader with timestamp, menu)
    const authorHeaderMount = this.container.querySelector('.follow-packs__detail-author-header');
    if (authorHeaderMount && event.id) {
      const noteHeader = new NoteHeader({
        pubkey: event.pubkey,
        eventId: event.id,
        timestamp: event.created_at,
        rawEvent: event,
        showVerification: true,
        showTimestamp: true,
        showMenu: true,
      });
      authorHeaderMount.appendChild(noteHeader.getElement());
    }

    // Author mention in detail info
    const authorMentionContainer = this.container.querySelector('.follow-packs__detail-author-mention') as HTMLElement;
    if (authorMentionContainer) {
      const profileService = UserProfileService.getInstance();
      const profiles = await profileService.getUserProfiles([pack.authorPubkey]);
      const profile = profiles.get(pack.authorPubkey);
      const username = profile?.display_name || profile?.name || 'Unknown';
      const avatarUrl = profile?.picture || '';
      authorMentionContainer.innerHTML = renderUserMention(pack.authorPubkey, { username, avatarUrl });
      setupUserMentionHandlers(authorMentionContainer);
    }

    // ISL
    const islMount = this.container.querySelector('.follow-packs__detail-isl');
    if (islMount && event.id) {
      const addressableId = getAddressableIdentifier(event);
      const noteId = addressableId || event.id;

      const isl = new InteractionStatusLine({
        noteId,
        authorPubkey: event.pubkey,
        originalEvent: event,
        fetchStats: true,
        isLoggedIn,
        articleEventId: event.id,
      });
      islMount.appendChild(isl.getElement());
    }

    // Replies
    const repliesContainer = this.container.querySelector('.follow-packs__detail-replies') as HTMLElement;
    if (repliesContainer && event.id) {
      const addressableId = getAddressableIdentifier(event);
      const noteId = addressableId || event.id;
      const repliesRenderer = new RepliesRenderer({
        container: repliesContainer,
        noteId,
        noteAuthor: event.pubkey,
      });
      repliesRenderer.loadAndRender();
    }

    // Addon-dependent buttons (See Notes, Edit List) — only if Follow Packs addon is enabled
    const actionsContainer = this.container.querySelector('.follow-packs__detail-actions');
    if (actionsContainer && isLoggedIn) {
      const { isFollowPacksEnabled } = await import('../../addons/follow-packs/index');
      if (isFollowPacksEnabled()) {
        const seeNotesBtn = document.createElement('button');
        seeNotesBtn.className = 'btn btn--passive follow-packs__btn-see-notes';
        seeNotesBtn.textContent = 'See Notes';
        actionsContainer.appendChild(seeNotesBtn);

        if (isOwner) {
          const editBtn = document.createElement('button');
          editBtn.className = 'btn btn--secondary follow-packs__btn-edit';
          editBtn.textContent = 'Edit List';
          actionsContainer.appendChild(editBtn);
        }
      }
    }

    // Action buttons
    this.setupActions(pack);

    // Load members
    await this.loadMembers(pack);
  }

  private setupActions(pack: FollowPack): void {
    // Follow All
    this.container.querySelector('.follow-packs__btn-follow-all')?.addEventListener('click', async () => {
      const { getFollowItems, setFollowItems } = await import('../../lists/follows');
      const currentFollows = getFollowItems();
      const followedPubkeys = new Set(currentFollows.map(f => f.pubkey));
      const newFollows = pack.userPubkeys.filter(pk => !followedPubkeys.has(pk));

      if (newFollows.length === 0) {
        const { ToastService } = await import('../../services/ToastService');
        ToastService.show('Already following all members', 'success');
        return;
      }

      const newItems: FollowItem[] = newFollows.map(pubkey => ({
        id: pubkey,
        pubkey,
      }));
      setFollowItems([...currentFollows, ...newItems]);

      const { ToastService } = await import('../../services/ToastService');
      ToastService.show(`Following ${newFollows.length} new people`, 'success');
    });

    // DM button → navigate to DM conversation with pack author
    this.container.querySelector('.follow-packs__dm-btn')?.addEventListener('click', () => {
      const npub = hexToNpub(pack.authorPubkey);
      if (npub) this.router.navigate(`/messages/${npub}`);
    });

    // See Notes — open pack timeline in scc via TypedEventBus
    this.container.querySelector('.follow-packs__btn-see-notes')?.addEventListener('click', () => {
      TypedEventBus.getInstance().emit('list:open', { listType: 'follow-packs', packId: pack.id, packMode: 'timeline' as const });
    });

    // Edit List — open pack edit view in scc via TypedEventBus
    this.container.querySelector('.follow-packs__btn-edit')?.addEventListener('click', () => {
      TypedEventBus.getInstance().emit('list:open', { listType: 'follow-packs', packId: pack.id, packMode: 'edit' as const });
    });
  }

  private async loadMembers(pack: FollowPack): Promise<void> {
    const memberList = this.container.querySelector('.follow-packs__members') as HTMLElement | null;
    if (!memberList) return;
    await renderFollowPackMembers(pack, memberList);
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.container.innerHTML = '';
    this.container.remove();
  }
}
