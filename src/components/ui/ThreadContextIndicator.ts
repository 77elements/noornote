/**
 * ThreadContextIndicator Component
 * Shows thread context above a reply:
 * - Original post (root) - truncated, clickable
 * - "..." if intermediate replies exist
 * - Direct parent - truncated, clickable
 *
 * Replaces/extends ReplyIndicator with full thread context
 */

import { ThreadOrchestrator } from '../../services/orchestration/ThreadOrchestrator';
import type { ThreadContext } from '../../services/orchestration/ThreadOrchestrator';
import { UserProfileService } from '../../services/UserProfileService';
import { Router } from '../../services/Router';
import { truncateNoteContent } from '../../helpers/truncateNoteContent';
import { encodeNevent } from '../../services/NostrToolsAdapter';
import { npubToUsername } from '../../helpers/npubToUsername';
import { escapeHtmlAttr } from '../../helpers/escapeHtml';

export interface ThreadContextIndicatorOptions {
  noteId: string; // The current note (reply) we're showing context for
}

export class ThreadContextIndicator {
  private element: HTMLElement;
  private options: ThreadContextIndicatorOptions;
  private threadOrchestrator: ThreadOrchestrator;
  private userProfileService: UserProfileService;
  private router: Router;

  constructor(options: ThreadContextIndicatorOptions) {
    this.options = options;
    this.element = this.createElement();
    this.threadOrchestrator = ThreadOrchestrator.getInstance();
    this.userProfileService = UserProfileService.getInstance();
    this.router = Router.getInstance();

    // Load thread context asynchronously
    this.loadThreadContext();
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
      const context = await this.threadOrchestrator.fetchParentChain(this.options.noteId);

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

    // Get user profile
    const profile = await this.userProfileService.getUserProfile(pubkey);
    const displayName = profile.display_name || profile.name || 'Anonymous';
    const avatarUrl = profile.picture || '';

    // Addressable parents (kind 30000+) get a kind-aware label from tags
    // instead of a markdown-body snippet, plus a kind-specific navigation route.
    const isAddressable = kind >= 30000 && kind < 40000;
    let previewHtml: string;
    let onClick: () => void;

    if (isAddressable) {
      const titleTag = tags.find(t => t[0] === 'title')?.[1]
                    || tags.find(t => t[0] === 'name')?.[1]
                    || '(untitled)';
      const label = kind === 30023 ? 'Article'
                  : kind === 30402 ? 'Listing'
                  : kind === 32267 ? 'App'
                  : kind === 39089 ? 'Follow Pack'
                  : `Kind ${kind}`;
      previewHtml = `<strong>${escapeHtmlAttr(label)}:</strong> ${escapeHtmlAttr(titleTag)}`;

      const dtag = tags.find(t => t[0] === 'd')?.[1] || '';
      onClick = async () => {
        const { encodeNaddr } = await import('../../services/NostrToolsAdapter');
        const naddr = encodeNaddr({ kind, pubkey, identifier: dtag, relays: [] });
        const route = kind === 30023 ? `/article/${naddr}`
                    : kind === 30402 ? `/listing/${naddr}`
                    : kind === 32267 ? `/zapstore/${naddr}`
                    : kind === 39089 ? `/follow-pack/${naddr}`
                    : `/note/${encodeNevent(eventId)}`;
        this.router.navigate(route);
      };
    } else {
      // Regular note: resolve mentions, truncate body
      const mentionedProfiles = new Map<string, any>();
      const npubMatches = content.match(/nostr:npub1[023456789acdefghjklmnpqrstuvwxyz]{58}/gi);
      if (npubMatches) {
        await Promise.all(npubMatches.map(async (match) => {
          try {
            const npub = match.replace('nostr:', '');
            const { decodeNip19 } = await import('../../services/NostrToolsAdapter');
            const decoded = decodeNip19(npub);
            if (decoded.type === 'npub') {
              const mentionProfile = await this.userProfileService.getUserProfile(decoded.data);
              mentionedProfiles.set(decoded.data, mentionProfile);
            }
          } catch (_err) {}
        }));
      }

      const profileResolver = (hexPubkey: string) => mentionedProfiles.get(hexPubkey) || null;
      const contentWithMentions = npubToUsername(content, 'html-multi', profileResolver);
      previewHtml = truncateNoteContent(contentWithMentions, 100);

      onClick = () => {
        const nevent = encodeNevent(eventId);
        this.router.navigate(`/note/${nevent}`);
      };
    }

    item.innerHTML = `
      <img class="profile-pic profile-pic--mini" src="${escapeHtmlAttr(avatarUrl)}" alt="${escapeHtmlAttr(displayName)}" />
      <span class="thread-context-content">${previewHtml}</span>
    `;

    item.style.cursor = 'pointer';
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
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
