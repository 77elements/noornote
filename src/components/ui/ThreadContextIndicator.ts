/**
 * ThreadContextIndicator Component
 * Shows thread context above a reply:
 * - Original post (root) - truncated, clickable
 * - "..." if intermediate replies exist
 * - Direct parent - truncated, clickable
 *
 * Replaces/extends ReplyIndicator with full thread context
 */

import { ModuleLoader } from '../../core/ModuleLoader';
import {
  type SingleNoteModuleApi,
  type ThreadContext,
} from '../../modules/single-note/contracts';
import { UserProfileService } from '../../services/UserProfileService';
import { Router } from '../../services/Router';
import { getViewNavigationController } from '../../services/ViewNavigationController';
import { truncateNoteContent } from '../../helpers/truncateNoteContent';
import { encodeNevent } from '../../services/NostrToolsAdapter';
import { npubToUsername } from '../../helpers/npubToUsername';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import {
  extractZapperPubkey,
  getZapAmountSats,
  extractZapMessage,
  formatNumberWithCommas,
} from '../../helpers/zapUtils';
import { applyAuthorRelationshipRing } from '../../helpers/applyAuthorRelationshipRing';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

export interface ThreadContextIndicatorOptions {
  noteId: string; // The current note (reply) we're showing context for
  replyContext?: boolean; // SNV reply thread: prefix each band with a ↳ ("in reply to")
}

export class ThreadContextIndicator {
  private element: HTMLElement;
  private options: ThreadContextIndicatorOptions;
  private _singleNoteApi?: SingleNoteModuleApi | null;
  private get singleNoteApi(): SingleNoteModuleApi | null {
    return (this._singleNoteApi ??=
      ModuleLoader.getInstance().getApi<SingleNoteModuleApi>('single-note'));
  }
  private userProfileService: UserProfileService;
  private router: Router;

  constructor(options: ThreadContextIndicatorOptions) {
    this.options = options;
    this.element = this.createElement();
    this.userProfileService = UserProfileService.getInstance();
    this.router = Router.getInstance();

    // Load thread context asynchronously
    void this.loadThreadContext();
  }

  /**
   * Create initial HTML structure (loading state)
   */
  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'thread-context-indicator';
    container.innerHTML = '';
    return container;
  }

  /**
   * Load thread context and render
   */
  private async loadThreadContext(): Promise<void> {
    try {
      const context = await this.singleNoteApi?.fetchParentChain(
        this.options.noteId
      );

      if (!context) {
        this.element.style.display = 'none';
        return;
      }

      if (!context.directParent && !context.root) {
        // No thread context, hide component
        this.element.style.display = 'none';
        return;
      }

      await this.renderThreadContext(context);
    } catch (_error) {
      console.error('Failed to load thread context:', _error);
      this.element.innerHTML = `
        <div class="thread-context-error">Failed to load thread context</div>
      `;
    }
  }

  /**
   * Render thread context with root, "...", and direct parent
   */
  private async renderThreadContext(context: ThreadContext): Promise<void> {
    this.element.innerHTML = ''; // Clear loading state
    this.element.className = 'thread-context-indicator';

    // Show root note if it exists and is different from direct parent
    if (context.root) {
      const rootItem = await this.createThreadItem(
        context.root.eventId,
        context.root.content,
        context.root.pubkey,
        context.root.kind,
        context.root.tags
      );
      this.element.appendChild(rootItem);
    }

    // Show "..." if there are skipped intermediate replies
    if (context.hasSkippedReplies) {
      const ellipsis = document.createElement('div');
      ellipsis.className = 'thread-context-ellipsis';
      ellipsis.textContent = '...';
      this.element.appendChild(ellipsis);
    }

    // Show direct parent
    if (context.directParent) {
      const parentItem = await this.createThreadItem(
        context.directParent.eventId,
        context.directParent.content,
        context.directParent.pubkey,
        context.directParent.kind,
        context.directParent.tags
      );
      this.element.appendChild(parentItem);
    }
  }

  /**
   * Create a single thread context item (truncated note with avatar + username).
   * For addressable parents (kind 30023 articles, kind 30402 listings, etc.)
   * the preview shows the title from tags instead of the raw body, and the
   * click navigates to the kind-specific view (article / listing / …).
   */
  private async createThreadItem(
    eventId: string,
    content: string,
    pubkey: string,
    kind: number = 1,
    tags: string[][] = []
  ): Promise<HTMLElement> {
    const item = document.createElement('div');
    item.className = 'thread-context-item';
    item.dataset.eventId = eventId;

    // For a zap receipt (kind:9735) the event author is the wallet/LNURL server, which has no
    // profile picture — so resolve the avatar + name to the actual ZAPPER instead.
    const isZap = kind === 9735;
    const avatarPubkey = isZap
      ? extractZapperPubkey({ pubkey, tags, kind } as NostrEvent)
      : pubkey;
    const profile = await this.userProfileService.getUserProfile(avatarPubkey);
    const displayName = profile.display_name || profile.name || 'Anonymous';
    const avatarUrl = profile.picture || '';

    // Addressable parents (kind 30000+) get a kind-aware label from tags
    // instead of a markdown-body snippet, plus a kind-specific navigation route.
    const isAddressable = kind >= 30000 && kind < 40000;
    let previewHtml: string;
    let onClick: (e?: MouseEvent) => void;

    if (isZap) {
      // Zap receipt has no body — show "⚡ N sats" + optional zap comment; click opens its thread.
      const synth = { pubkey, tags, kind } as NostrEvent;
      const msg = extractZapMessage(synth);
      const msgText = msg
        ? ` "${msg.length > 80 ? `${msg.slice(0, 80)}…` : msg}"`
        : '';
      previewHtml = `⚡ ${formatNumberWithCommas(getZapAmountSats(synth))} sats${escapeHtml(msgText)}`;
      onClick = (e?: MouseEvent) => {
        getViewNavigationController().openView(
          'single-note',
          encodeNevent(eventId),
          e
        );
      };
    } else if (isAddressable) {
      const titleTag =
        tags.find(t => t[0] === 'title')?.[1] ||
        tags.find(t => t[0] === 'name')?.[1] ||
        '(untitled)';
      const label =
        kind === 30023
          ? 'Article'
          : kind === 30402
            ? 'Listing'
            : kind === 32267
              ? 'App'
              : kind === 39089
                ? 'Follow Pack'
                : `Kind ${kind}`;
      previewHtml = `<strong>${escapeHtmlAttr(label)}:</strong> ${escapeHtmlAttr(titleTag)}`;

      const dtag = tags.find(t => t[0] === 'd')?.[1] || '';
      onClick = async (e?: MouseEvent) => {
        const { encodeNaddr } = await import(
          '../../services/NostrToolsAdapter'
        );
        const naddr = encodeNaddr({
          kind,
          pubkey,
          identifier: dtag,
          relays: [],
        });
        // Articles have a secondary-pane view; route them through the controller so
        // right-pane mode opens them in the scc. Other addressable kinds have no scc
        // tab view yet, so they keep full Router navigation.
        if (kind === 30023) {
          getViewNavigationController().openView('article', naddr, e);
          return;
        }
        if (kind === 39089) {
          getViewNavigationController().openView('follow-pack', naddr, e);
          return;
        }
        if (kind === 30402) {
          getViewNavigationController().openView('listing', naddr, e);
          return;
        }
        // Remaining addressable kinds (e.g. zapstore apps) have no scc view yet.
        const route =
          kind === 32267
            ? `/zapstore/${naddr}`
            : `/note/${encodeNevent(eventId)}`;
        this.router.navigate(route);
      };
    } else {
      // Regular note: resolve mentions, truncate body
      const mentionedProfiles = new Map<
        string,
        import('../../services/UserProfileService').UserProfile
      >();
      const npubMatches = content.match(
        /nostr:npub1[023456789acdefghjklmnpqrstuvwxyz]{58}/gi
      );
      if (npubMatches) {
        await Promise.all(
          npubMatches.map(async match => {
            try {
              const npub = match.replace('nostr:', '');
              const { decodeNip19 } = await import(
                '../../services/NostrToolsAdapter'
              );
              const decoded = decodeNip19(npub);
              if (decoded.type === 'npub') {
                const mentionProfile =
                  await this.userProfileService.getUserProfile(decoded.data);
                mentionedProfiles.set(decoded.data, mentionProfile);
              }
            } catch (_err) {
              /* ignore */
            }
          })
        );
      }

      const profileResolver = (hexPubkey: string) =>
        mentionedProfiles.get(hexPubkey) || null;
      const contentWithMentions = npubToUsername(
        content,
        'html-multi',
        profileResolver
      );
      previewHtml = truncateNoteContent(contentWithMentions, 100);

      onClick = (e?: MouseEvent) => {
        const nevent = encodeNevent(eventId);
        getViewNavigationController().openView('single-note', nevent, e);
      };
    }

    // SNV reply threads lead with a ↳ ("in reply to"); the TV band omits it.
    const arrow = this.options.replyContext
      ? '<span class="thread-context-arrow">↳</span>'
      : '';

    item.innerHTML = `
      ${arrow}
      <img class="profile-pic profile-pic--mini" src="${escapeHtmlAttr(avatarUrl)}" alt="${escapeHtmlAttr(displayName)}" width="18" height="18" loading="lazy" decoding="async" />
      <span class="thread-context-content"><b class="thread-context-author">${escapeHtml(displayName)}</b> ${previewHtml}</span>
    `;

    // In an SNV reply thread, ring the parent author's avatar with their relationship
    // to the current user (red = they muted you, green = they follow you) — same cue
    // as the reply author's avatar, so you can see who upthread won't get your reply.
    if (this.options.replyContext) {
      applyAuthorRelationshipRing(
        item.querySelector('.profile-pic--mini'),
        avatarPubkey
      );
    }

    item.style.cursor = 'pointer';
    item.addEventListener('click', e => {
      e.stopPropagation();
      onClick(e);
    });

    return item;
  }

  /**
   * Get the HTML element
   */
  getElement(): HTMLElement {
    return this.element;
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.element.remove();
  }
}
