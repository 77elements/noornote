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
        context.root.pubkey
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
        context.directParent.pubkey
      );
      this.element.appendChild(parentItem);
    }
  }

  /**
   * Create a single thread context item (truncated note with avatar + username)
   */
  private async createThreadItem(
    eventId: string,
    content: string,
    pubkey: string
  ): Promise<HTMLElement> {
    const item = document.createElement('div');
    item.className = 'thread-context-item';
    item.dataset.eventId = eventId;

    // Get user profile
    const profile = await this.userProfileService.getUserProfile(pubkey);
    const displayName = profile.display_name || profile.name || 'Anonymous';
    const avatarUrl = profile.picture || '';

    // Extract mentioned pubkeys from content and load their profiles
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

    // Resolve mentions BEFORE truncating (so regex matches full npubs)
    const profileResolver = (hexPubkey: string) => {
      return mentionedProfiles.get(hexPubkey) || null;
    };
    const contentWithMentions = npubToUsername(content, 'html-multi', profileResolver);

    // Truncate AFTER mention resolution
    const truncated = truncateNoteContent(contentWithMentions, 100);

    // Build HTML
    item.innerHTML = `
      <img class="profile-pic profile-pic--mini" src="${escapeHtmlAttr(avatarUrl)}" alt="${escapeHtmlAttr(displayName)}" />
      <span class="thread-context-content">${truncated}</span>
    `;

    // Make clickable - navigate to note
    item.style.cursor = 'pointer';
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const nevent = encodeNevent(eventId);
      this.router.navigate(`/note/${nevent}`);
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
