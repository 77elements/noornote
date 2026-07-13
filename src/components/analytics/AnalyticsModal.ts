/**
 * AnalyticsModal - Detailed Stats Modal for Notes
 * Shows detailed breakdown of all interactions (replies, zaps, reposts, etc.)
 * Uses ModalService for modal infrastructure
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { encodeNevent } from '../../services/NostrToolsAdapter';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { ReactionsModuleApi, DetailedStats } from '../../modules/reactions/contracts';
import type { TimelineModuleApi } from '../../modules/timeline/contracts';
import { formatRelayUrl } from '../../helpers/formatRelayUrl';
import { UserProfileService } from '../../services/UserProfileService';
import { Router } from '../../services/Router';
import { ModalService } from '../../services/ModalService';
import { AuthGuard } from '../../services/AuthGuard';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { parseBolt11Amount, formatNumberWithCommas } from '../../helpers/zapUtils';
import { renderUserMention, setupUserMentionHandlers, type UserMentionProfile } from '../../helpers/UserMentionHelper';
import type { CustomDropdown } from '../ui/CustomDropdown';
import {
  buildEmojiMenu,
  buildChildrenContainer,
  collectTreePubkeys,
  reactionDisplayEmoji,
  attachThreadLongPress,
  type ReactionThreadContext,
} from '../../helpers/reactionThreadView';

// Shared modal dimensions for consistent sizing
const MODAL_CONFIG = {
  title: 'Analytics',
  width: '40%',
  height: '40%'
} as const;

export class AnalyticsModal {
  private static instance: AnalyticsModal | null = null;
  private _reactionsApi?: ReactionsModuleApi | null;
  private get reactionsApi(): ReactionsModuleApi | null {
    return this._reactionsApi ??= ModuleLoader.getInstance().getApi<ReactionsModuleApi>('reactions');
  }
  private userProfileService: UserProfileService;
  private router: Router;
  private modalService: ModalService;
  /** Reaction-thread pulldowns from the last render — destroyed on the next
   *  open so their document listeners don't accumulate across modal opens. */
  private activeDropdowns: CustomDropdown[] = [];

  private constructor() {
    this.userProfileService = UserProfileService.getInstance();
    this.router = Router.getInstance();
    this.modalService = ModalService.getInstance();
  }

  /**
   * Get singleton instance (create if needed)
   */
  public static getInstance(): AnalyticsModal {
    if (!AnalyticsModal.instance) {
      AnalyticsModal.instance = new AnalyticsModal();
    }
    return AnalyticsModal.instance;
  }

  /**
   * Show modal with analytics for a note
   */
  public async show(noteId: string, rawEvent?: NostrEvent): Promise<void> {
    // Check authentication for viewing detailed analytics (Read-Protected action)
    if (!AuthGuard.requireAuth('view detailed analytics')) {
      return;
    }

    // Tear down pulldowns from a previous open before building fresh ones.
    this.destroyDropdowns();

    // Show loading state first
    this.modalService.show({ ...MODAL_CONFIG, content: this.renderLoadingContent() });

    // Fetch detailed stats
    try {
      const stats = await this.reactionsApi?.getDetailedStats(noteId);
      if (!stats) {
        this.modalService.show({ ...MODAL_CONFIG, content: this.renderErrorContent('Reactions module not available') });
        return;
      }
      const statsContent = await this.renderStatsContent(stats, noteId, rawEvent);
      this.modalService.show({ ...MODAL_CONFIG, content: statsContent });
      this.updateISLInDOM(noteId, stats);
    } catch (error) {
      console.error('Failed to fetch analytics:', error);
      this.modalService.show({ ...MODAL_CONFIG, content: this.renderErrorContent('Failed to load analytics data') });
    }
  }

  /**
   * Render loading content
   */
  private renderLoadingContent(): string {
    return `
      <div class="modal__loading">
        <div class="loading-spinner"></div>
        <p>Loading analytics data...</p>
      </div>
    `;
  }

  /**
   * Render error content
   */
  private renderErrorContent(message: string): string {
    return `
      <div class="modal__error">
        <p>${escapeHtml(message)}</p>
      </div>
    `;
  }

  /**
   * Render an empty section with consistent styling
   */
  private renderEmptySection(title: string, emptyMessage: string): string {
    return `
      <div class="analytics-modal__section">
        <h2>${title}</h2>
        <div class="analytics-modal__separator"></div>
        <p class="analytics-modal__empty">${emptyMessage}</p>
      </div>
    `;
  }

  /**
   * Render a section with content
   */
  private renderSection(title: string, content: string, listClass = 'analytics-modal__list'): string {
    return `
      <div class="analytics-modal__section">
        <h2>${title}</h2>
        <div class="analytics-modal__separator"></div>
        <div class="${listClass}">${content}</div>
      </div>
    `;
  }

  /**
   * Extract zapper pubkey from zap event (reads description tag for actual zapper)
   */
  private extractZapperPubkey(event: NostrEvent): string {
    const descTag = event.tags.find((tag: string[]) => tag[0] === 'description');
    if (descTag && descTag[1]) {
      try {
        const zapRequest = JSON.parse(descTag[1]);
        if (zapRequest.pubkey) {
          return zapRequest.pubkey;
        }
      } catch {
        // Parse error, use fallback
      }
    }
    return event.pubkey;
  }

  /**
   * Extract zap message from zap event description
   */
  private extractZapMessage(event: NostrEvent): string {
    const descTag = event.tags.find((tag: string[]) => tag[0] === 'description');
    if (descTag && descTag[1]) {
      try {
        const zapRequest = JSON.parse(descTag[1]);
        return zapRequest.content || '';
      } catch {
        // Parse error
      }
    }
    return '';
  }

  /**
   * Render a note link (for replies and quoted reposts)
   */
  private renderNoteLink(event: NostrEvent, profile: UserMentionProfile): string {
    return `<span class="user-mention" data-pubkey="${event.pubkey}"><a href="#" class="mention-link mention-link--bg" data-note-id="${event.id}"><img class="profile-pic profile-pic--mini" src="${escapeHtmlAttr(profile.avatarUrl)}" alt="" />${escapeHtml(profile.username)}</a></span>`;
  }

  /**
   * Get profile from map with fallback
   */
  private getProfile(pubkey: string, profileMap: Map<string, UserMentionProfile>): UserMentionProfile {
    return profileMap.get(pubkey) || { username: 'Anonymous', avatarUrl: '' };
  }

  /**
   * Render stats content
   */
  private async renderStatsContent(stats: DetailedStats, noteId: string, rawEvent?: NostrEvent): Promise<HTMLElement> {
    // Fetch the reaction-on-reaction tree so we can render the nested thread.
    const rootIds = stats.reactionEvents.map(e => e.id).filter((id): id is string => !!id);
    const reactionTree = await this.reactionsApi?.fetchReactionTree(rootIds) ?? new Map<string, NostrEvent[]>();

    // Collect all pubkeys for profile fetching (top-level + nested reactors)
    const allPubkeys = new Set<string>();
    stats.replyEvents.forEach(e => allPubkeys.add(e.pubkey));
    stats.repostEvents.forEach(e => allPubkeys.add(e.pubkey));
    stats.quotedEvents.forEach(e => allPubkeys.add(e.pubkey));
    stats.reactionEvents.forEach(e => allPubkeys.add(e.pubkey));
    stats.zapEvents.forEach(e => allPubkeys.add(this.extractZapperPubkey(e)));
    collectTreePubkeys(reactionTree).forEach(pk => allPubkeys.add(pk));

    // Fetch all profiles and build profile map
    const profileMap = new Map<string, UserMentionProfile>();
    await Promise.all(
      Array.from(allPubkeys).map(async (pubkey) => {
        const profile = await this.userProfileService.getUserProfile(pubkey);
        const username = profile.display_name || profile.name || profile.username || 'Anonymous';
        const avatarUrl = profile.picture || '';
        profileMap.set(pubkey, { username, avatarUrl });
      })
    );

    // Build sections HTML (pass profile map)
    const repliesSection = this.renderRepliesSection(stats.replyEvents, profileMap);
    const zapsSection = this.renderZapsSection(stats.zapEvents, profileMap);
    const repostsSection = this.renderRepostsSection(stats.repostEvents, profileMap);
    const quotedSection = this.renderQuotedRepostsSection(stats.quotedEvents, profileMap);
    const likesSection = this.renderLikesSection(stats.reactionEvents);

    // Relays this note was seen on / delivered to this session (empty for
    // notes only loaded from the local cache). Honest wording: "seen on",
    // not "posted to" — Nostr does not record original publish targets.
    const timelineApi = ModuleLoader.getInstance().getApi<TimelineModuleApi>('timeline');
    const seenOnRelays = timelineApi?.getEventRelays(noteId) ?? [];
    const seenOnSection = seenOnRelays.length > 0
      ? `<div class="analytics-modal__seen-on">Seen on ${escapeHtml(seenOnRelays.map(formatRelayUrl).join(', '))}</div>`
      : '';

    // Extract client tag if available
    const clientTag = rawEvent?.tags?.find((tag: string[]) => tag[0] === 'client');
    const clientName = clientTag?.[1] || null;
    const clientSection = clientName ? `<div class="analytics-modal__client">via ${escapeHtml(clientName)}</div>` : '';

    // Create container element
    const container = document.createElement('div');
    container.className = 'analytics-content';
    container.innerHTML = `
      ${repliesSection}
      ${zapsSection}
      ${repostsSection}
      ${quotedSection}
      ${likesSection}
      ${seenOnSection}
      ${clientSection}
    `;

    // Setup handlers (profile links in string-built sections)
    this.setupHandlers(container);

    // Fill the likes body with the interactive reaction tree (needs real DOM
    // for the pulldowns, so it can't live in the innerHTML string above).
    const likesBody = container.querySelector('[data-likes-body]');
    if (likesBody && stats.reactionEvents.length > 0) {
      const ctx: ReactionThreadContext = {
        reactionsApi: this.reactionsApi,
        tree: reactionTree,
        profiles: profileMap,
        dropdowns: this.activeDropdowns,
      };
      this.buildLikesTree(likesBody as HTMLElement, stats.reactionEvents, noteId, rawEvent, ctx);
      setupUserMentionHandlers(likesBody as HTMLElement);
    }

    return container;
  }

  /**
   * Render Replies section (links to reply notes)
   */
  private renderRepliesSection(replyEvents: NostrEvent[], profileMap: Map<string, UserMentionProfile>): string {
    if (replyEvents.length === 0) {
      return this.renderEmptySection('Replies (0)', 'No replies yet');
    }

    const userLinks = replyEvents.map(event => {
      const profile = this.getProfile(event.pubkey, profileMap);
      return this.renderNoteLink(event, profile);
    }).join(' ');

    return this.renderSection(`Replies (${replyEvents.length})`, userLinks);
  }

  /**
   * Render Zaps section (uses UserMentionHelper)
   */
  private renderZapsSection(zapEvents: NostrEvent[], profileMap: Map<string, UserMentionProfile>): string {
    if (zapEvents.length === 0) {
      return this.renderEmptySection('Zaps (0): 0 Sats', 'No zaps yet');
    }

    let totalSats = 0;
    const zapItems = zapEvents.map(event => {
      const zapperPubkey = this.extractZapperPubkey(event);
      const zapMessage = this.extractZapMessage(event);
      const profile = this.getProfile(zapperPubkey, profileMap);
      const bolt11Tag = event.tags.find((tag: string[]) => tag[0] === 'bolt11');
      const amount = bolt11Tag?.[1] ? parseBolt11Amount(bolt11Tag[1]) : 0;
      totalSats += amount;

      const messageHtml = zapMessage ? ` <span class="analytics-modal__zap-message">(${escapeHtml(zapMessage)})</span>` : '';

      return `
        <div class="analytics-modal__zap-item">
          ${renderUserMention(zapperPubkey, profile)}:
          <span class="analytics-modal__zap-amount">${formatNumberWithCommas(amount)} Sats</span>${messageHtml}
        </div>
      `;
    }).join('');

    return this.renderSection(`Zaps (${zapEvents.length}): ${formatNumberWithCommas(totalSats)} Sats`, zapItems, 'analytics-modal__zap-list');
  }

  /**
   * Render Reposts section (uses UserMentionHelper)
   */
  private renderRepostsSection(repostEvents: NostrEvent[], profileMap: Map<string, UserMentionProfile>): string {
    if (repostEvents.length === 0) {
      return this.renderEmptySection('Reposts (0)', 'No reposts yet');
    }

    const userLinks = repostEvents.map(event => {
      const profile = this.getProfile(event.pubkey, profileMap);
      return renderUserMention(event.pubkey, profile);
    }).join(' ');

    return this.renderSection(`Reposts (${repostEvents.length})`, userLinks);
  }

  /**
   * Render Quoted Reposts section (links to quote notes)
   */
  private renderQuotedRepostsSection(quotedEvents: NostrEvent[], profileMap: Map<string, UserMentionProfile>): string {
    if (quotedEvents.length === 0) {
      return this.renderEmptySection('Quoted Reposts (0)', 'No quoted reposts yet');
    }

    const userLinks = quotedEvents.map(event => {
      const profile = this.getProfile(event.pubkey, profileMap);
      return this.renderNoteLink(event, profile);
    }).join(' ');

    return this.renderSection(`Quoted Reposts (${quotedEvents.length})`, userLinks);
  }

  /**
   * Render the Likes section shell. The body is a placeholder that
   * renderStatsContent fills with the interactive reaction tree afterwards
   * (pulldowns need real DOM, not an innerHTML string).
   */
  private renderLikesSection(reactionEvents: NostrEvent[]): string {
    if (reactionEvents.length === 0) {
      return this.renderEmptySection('Likes (0)', 'No likes yet');
    }
    return `
      <div class="analytics-modal__section">
        <h2>Likes (${reactionEvents.length})</h2>
        <div class="analytics-modal__separator"></div>
        <div class="analytics-modal__likes-tree" data-likes-body></div>
      </div>
    `;
  }

  /**
   * Build the interactive likes tree into the placeholder body. One row per
   * top-level reaction (each individually addressable so "React to the emoji"
   * is unambiguous here), with the nested reaction thread under each ">".
   */
  private buildLikesTree(
    body: HTMLElement,
    reactionEvents: NostrEvent[],
    noteId: string,
    rawEvent: NostrEvent | undefined,
    ctx: ReactionThreadContext,
  ): void {
    for (const reaction of reactionEvents) {
      if ((reaction.content || '').trim() === '-') continue; // skip downvotes
      body.appendChild(this.buildTopLevelReactionRow(reaction, noteId, rawEvent, ctx));
    }
  }

  /**
   * A top-level reaction row: [ ">" toggle | spacer ] [ emoji pulldown ] (user).
   * Its "React with the same emoji" target is the note itself.
   */
  private buildTopLevelReactionRow(
    reaction: NostrEvent,
    noteId: string,
    rawEvent: NostrEvent | undefined,
    ctx: ReactionThreadContext,
  ): HTMLElement {
    const node = document.createElement('div');
    node.className = 'reaction-node';

    const row = document.createElement('div');
    row.className = 'reaction-node__row';

    const children = buildChildrenContainer(reaction, ctx);
    if (children) {
      const toggle = document.createElement('button');
      toggle.className = 'reaction-node__toggle';
      toggle.type = 'button';
      toggle.textContent = '>';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('title', 'Show reactions to this reaction');
      const toggleThread = () => {
        const open = node.classList.toggle('reaction-node--open');
        toggle.setAttribute('aria-expanded', String(open));
      };
      toggle.addEventListener('click', toggleThread);
      attachThreadLongPress(row, toggleThread);
      row.appendChild(toggle);
    } else {
      const spacer = document.createElement('span');
      spacer.className = 'reaction-node__toggle reaction-node__toggle--spacer';
      row.appendChild(spacer);
    }

    const noteAuthor = rawEvent?.pubkey || reaction.tags.find(t => t[0] === 'p')?.[1] || '';
    row.appendChild(buildEmojiMenu(reaction, noteId, noteAuthor, rawEvent, reactionDisplayEmoji(reaction), ctx));

    const profile = this.getProfile(reaction.pubkey, ctx.profiles);
    const user = document.createElement('span');
    user.className = 'reaction-node__user';
    user.innerHTML = `(${renderUserMention(reaction.pubkey, profile)})`;
    row.appendChild(user);

    node.appendChild(row);
    if (children) node.appendChild(children);
    return node;
  }

  /** Destroy tracked reaction pulldowns (their document listeners). */
  private destroyDropdowns(): void {
    this.activeDropdowns.forEach(dd => dd.destroy());
    this.activeDropdowns = [];
  }

  /**
   * Setup all handlers (UserMentionHelper + note links)
   */
  private setupHandlers(container: HTMLElement): void {
    // Setup profile link handlers via UserMentionHelper
    setupUserMentionHandlers(container);

    // Setup note link handlers (replies, quoted reposts)
    const noteLinks = container.querySelectorAll('[data-note-id]');
    noteLinks.forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const noteId = (link as HTMLElement).dataset.noteId;

        if (noteId) {
          this.modalService.hide();
          try {
            const nevent = encodeNevent(noteId);
            this.router.navigate(`/note/${nevent}`);
          } catch (error) {
            console.error('Failed to encode nevent:', error);
          }
        }
      });
    });
  }

  /**
   * Format number with comma thousands separator (US format)
   */
  /**
   * Update ISL stats in the DOM after fetching detailed analytics
   * Finds the ISL element by note ID and updates the counts
   */
  private updateISLInDOM(noteId: string, stats: DetailedStats): void {
    // Find ISL container by note ID
    const islContainer = document.querySelector(`.isl[data-note-id="${noteId}"]`);
    if (!islContainer) {
      return;
    }

    // Calculate total zap amount in sats
    let totalZapSats = 0;
    stats.zapEvents.forEach(event => {
      const bolt11Tag = event.tags.find((tag: string[]) => tag[0] === 'bolt11');
      if (bolt11Tag?.[1]) {
        totalZapSats += parseBolt11Amount(bolt11Tag[1]);
      }
    });

    // Update counts in DOM
    const repliesCount = islContainer.querySelector('.isl-reply .isl-count');
    const repostsCount = islContainer.querySelector('.isl-repost .isl-count');
    const quotedRepostsCount = islContainer.querySelector('.isl-quote .isl-count');
    const likesCount = islContainer.querySelector('.isl-like .isl-count');
    const zapsCount = islContainer.querySelector('.isl-zap .isl-count');

    if (repliesCount) {
      repliesCount.textContent = this.formatCountShort(stats.replyEvents.length);
    }
    if (repostsCount) {
      repostsCount.textContent = this.formatCountShort(stats.repostEvents.length);
    }
    if (quotedRepostsCount) {
      quotedRepostsCount.textContent = this.formatCountShort(stats.quotedEvents.length);
    }
    if (likesCount) {
      likesCount.textContent = this.formatCountShort(stats.reactionEvents.length);
    }
    if (zapsCount) {
      zapsCount.textContent = this.formatCountShort(totalZapSats);
    }
  }

  /**
   * Format count for ISL display (K/M abbreviations)
   */
  private formatCountShort(count: number): string {
    if (count >= 1000000) {
      return (count / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    }
    if (count >= 1000) {
      return (count / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    }
    return count.toString();
  }

  /**
   * Cleanup and destroy modal
   */
  public destroy(): void {
    this.modalService.hide();
    AnalyticsModal.instance = null;
  }
}
