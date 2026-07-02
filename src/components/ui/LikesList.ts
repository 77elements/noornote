/**
 * LikesList Component
 * Displays horizontal list of reaction badges (emoji + count) between ZapsList and ISL in SNV.
 * Groups top-level reactions by emoji, sorted by count (most popular first).
 *
 * Each badge is a pulldown (same pattern as the repost menu):
 *   - React with the same emoji → like the note with that emoji
 *   - React to the emoji        → pick an emoji, react on that reaction (kind:7 → kind:7)
 * A reaction that has reactions of its own gets a ">" toggle that expands the
 * nested reaction thread underneath, indented and recursive.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { ReactionsModuleApi } from '../../modules/reactions/contracts';
import { resolveReactionEmoji } from '../../helpers/formatCustomEmojis';
import { escapeHtml } from '../../helpers/escapeHtml';
import { setupUserMentionHandlers } from '../../helpers/UserMentionHelper';
import {
  buildEmojiMenu,
  buildChildrenContainer,
  buildReactionProfileMap,
  collectTreePubkeys,
  attachThreadLongPress,
  type ReactionThreadContext,
} from '../../helpers/reactionThreadView';

interface ReactionGroup {
  /** Display emoji: raw unicode (escaped downstream) or resolved custom <img>. */
  emojiHtml: string;
  count: number;
  /** The individual kind:7 events in this emoji group. */
  events: NostrEvent[];
}

export class LikesList {
  private element: HTMLElement | null = null;
  private reactionEvents: NostrEvent[];
  private noteId: string;
  private authorPubkey: string;
  private _reactionsApi?: ReactionsModuleApi | null;
  private get reactionsApi(): ReactionsModuleApi | null {
    return this._reactionsApi ??= ModuleLoader.getInstance().getApi<ReactionsModuleApi>('reactions');
  }
  /** Original reacted-to event — required for NIP-25-compliant reactions on
   *  addressable events (long-form articles etc.) and used as the "react with
   *  the same emoji" target for top-level badges. */
  private originalEvent?: NostrEvent;

  /** reaction-on-reaction tree + shared render context. */
  private ctx: ReactionThreadContext | null = null;

  constructor(reactionEvents: NostrEvent[], noteId: string, authorPubkey: string, originalEvent?: NostrEvent) {
    this.reactionEvents = reactionEvents;
    this.noteId = noteId;
    this.authorPubkey = authorPubkey;
    if (originalEvent) this.originalEvent = originalEvent;
  }

  /**
   * Initialize the component (must be called after constructor)
   */
  public async init(): Promise<void> {
    // Fetch the reaction-on-reaction tree rooted at the top-level reactions,
    // then prefetch the reactors' profiles for the "(username)" links.
    const rootIds = this.reactionEvents.map(e => e.id).filter((id): id is string => !!id);
    const tree = await this.reactionsApi?.fetchReactionTree(rootIds) ?? new Map<string, NostrEvent[]>();
    const profiles = await buildReactionProfileMap(collectTreePubkeys(tree));
    this.ctx = { reactionsApi: this.reactionsApi, tree, profiles, dropdowns: [] };
    this.element = this.createElement();
  }

  /**
   * Group top-level reactions by emoji and count occurrences
   */
  private groupReactions(): ReactionGroup[] {
    const groups = new Map<string, ReactionGroup>();

    for (const event of this.reactionEvents) {
      const content = (event.content || '').trim();
      if (content === '-') continue; // Skip downvotes (not displayed)

      const key = (content === '+' || content === '') ? '❤️' : content;
      let group = groups.get(key);
      if (!group) {
        const isCustom = key.startsWith(':') && key.endsWith(':');
        group = { emojiHtml: isCustom ? resolveReactionEmoji(event) : escapeHtml(key), count: 0, events: [] };
        groups.set(key, group);
      }
      group.count += 1;
      group.events.push(event);
    }

    return Array.from(groups.values()).sort((a, b) => b.count - a.count);
  }

  /**
   * Create LikesList element
   */
  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'likes-list';

    const groups = this.groupReactions();
    if (groups.length === 0 || !this.ctx) {
      container.style.display = 'none';
      return container;
    }
    const ctx = this.ctx;

    const scrollContainer = document.createElement('div');
    scrollContainer.className = 'likes-list__scroll';

    for (const group of groups) {
      // Representative reaction for the aggregated badge: for "React to the
      // emoji" on a group with count > 1 this targets the first reactor's
      // reaction (a rare case for a playful feature).
      const rep = group.events[0]!;
      const hasChildren = group.events.some(e => e.id && ctx.tree.has(e.id));

      const badgeRow = document.createElement('div');
      badgeRow.className = 'likes-list__badge-row';

      // Collapsible children container (built once, toggled via ">").
      let childrenWrap: HTMLElement | null = null;
      if (hasChildren) {
        childrenWrap = document.createElement('div');
        childrenWrap.className = 'likes-list__children';
        for (const reaction of group.events) {
          // buildChildrenContainer returns a `.reaction-node__children` wrapper
          // that is display:none by default (it expects a .reaction-node--open
          // parent to reveal it). Here the badge-row toggle controls visibility
          // via .likes-list__children, so lift the individual node rows out of
          // that hidden wrapper into the badge's own children container.
          const sub = buildChildrenContainer(reaction, ctx);
          if (sub) while (sub.firstChild) childrenWrap.appendChild(sub.firstChild);
        }

        const toggle = document.createElement('button');
        toggle.className = 'reaction-node__toggle';
        toggle.type = 'button';
        toggle.textContent = '>';
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('title', 'Show reactions to this reaction');
        const toggleThread = () => {
          const open = badgeRow.classList.toggle('likes-list__badge-row--open');
          toggle.setAttribute('aria-expanded', String(open));
        };
        toggle.addEventListener('click', toggleThread);
        // Mobile: long-press anywhere on the pill expands the thread (the thin
        // ">" is hard to tap) and suppresses the pulldown that a tap would open.
        attachThreadLongPress(badgeRow, toggleThread);
        badgeRow.appendChild(toggle);
      }

      // Emoji badge as a pulldown: same emoji → like the note; react to → the reaction.
      const countHtml = `<span class="likes-list__count">${group.count}</span>`;
      badgeRow.appendChild(
        buildEmojiMenu(rep, this.noteId, this.authorPubkey, this.originalEvent, group.emojiHtml, ctx, countHtml)
      );

      scrollContainer.appendChild(badgeRow);
      if (childrenWrap) badgeRow.appendChild(childrenWrap);
    }

    container.appendChild(scrollContainer);

    // Make the "(username)" profile links inside the tree clickable.
    setupUserMentionHandlers(container);

    return container;
  }

  /**
   * Get DOM element
   */
  public getElement(): HTMLElement {
    if (!this.element) {
      throw new Error('LikesList not initialized. Call init() first.');
    }
    return this.element;
  }

  /**
   * Destroy component
   */
  public destroy(): void {
    // Tear down every pulldown so their document listeners don't leak.
    this.ctx?.dropdowns.forEach(dd => dd.destroy());
    if (this.ctx) this.ctx.dropdowns = [];
    if (this.element) {
      this.element.remove();
    }
  }
}
