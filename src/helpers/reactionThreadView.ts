/**
 * reactionThreadView
 *
 * Shared, interactive renderer for the reaction-on-reaction tree (kind:7 → kind:7).
 * Used by the LikesList (below the note in SingleNoteView) and the Analytics
 * modal so both surfaces render and behave identically (DRY).
 *
 * Each emoji is a small pulldown (same pattern as the mobile repost menu):
 *   - "React with the same emoji" → react on the emoji's target with this emoji
 *   - "React to the emoji"        → pick an emoji, react on the reaction itself
 * A reaction that itself has reactions gets a ">" toggle that expands its
 * children, indented, recursively.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ReactionsModuleApi } from '../modules/reactions/contracts';
import { CustomDropdown } from '../components/ui/CustomDropdown';
import { AuthGuard } from '../services/AuthGuard';
import { UserProfileService } from '../services/UserProfileService';
import { resolveReactionEmoji } from './formatCustomEmojis';
import {
  renderUserMention,
  type UserMentionProfile,
} from './UserMentionHelper';
import { escapeHtml } from './escapeHtml';
import { isCustomEmojisEnabled } from '../addons/custom-emojis/index';
import type { CustomEmojiEntry } from '../components/emoji/EmojiPicker';

export interface ReactionThreadContext {
  reactionsApi: ReactionsModuleApi | null;
  /** parentEventId → its direct kind:7 child reactions. */
  tree: Map<string, NostrEvent[]>;
  /** pubkey → display profile, for the "(username)" links. */
  profiles: Map<string, UserMentionProfile>;
  /** CustomDropdown instances created here — caller MUST destroy() them on
   *  teardown, otherwise their document listeners leak. */
  dropdowns: CustomDropdown[];
}

/** Cap recursion so a relay serving a reaction cycle can't blow the stack. */
const MAX_RENDER_DEPTH = 20;

/** Normalize NIP-25 content to safe display HTML (custom emojis → <img>).
 *  The native-emoji branch is escaped: `content` is attacker-controlled and
 *  ends up in innerHTML, so a crafted kind:7 must not inject markup. */
export function reactionDisplayEmoji(event: NostrEvent): string {
  const c = (event.content || '').trim();
  if (c === '' || c === '+') return '❤️';
  if (c.startsWith(':') && c.endsWith(':')) return resolveReactionEmoji(event);
  return escapeHtml(c);
}

/** The plain emoji string to publish when reacting "with the same emoji". */
function sameEmojiContent(event: NostrEvent): string {
  const c = (event.content || '').trim();
  return c === '' ? '+' : c;
}

function customEmojiTag(
  event: NostrEvent
): [string, string, string] | undefined {
  const t = event.tags.find(x => x[0] === 'emoji' && !!x[1] && !!x[2]);
  return t ? ['emoji', t[1]!, t[2]!] : undefined;
}

/** Every pubkey that appears anywhere in the tree (for name prefetching). */
export function collectTreePubkeys(
  tree: Map<string, NostrEvent[]>
): Set<string> {
  const set = new Set<string>();
  tree.forEach(children => children.forEach(c => set.add(c.pubkey)));
  return set;
}

/** Fetch display profiles for the given pubkeys (never rejects per entry). */
export async function buildReactionProfileMap(
  pubkeys: Iterable<string>
): Promise<Map<string, UserMentionProfile>> {
  const svc = UserProfileService.getInstance();
  const map = new Map<string, UserMentionProfile>();
  await Promise.all(
    [...new Set(pubkeys)].map(async pk => {
      try {
        const p = await svc.getUserProfile(pk);
        map.set(pk, {
          username: p.display_name || p.name || p.username || 'Anonymous',
          avatarUrl: p.picture || '',
        });
      } catch {
        map.set(pk, { username: 'Anonymous', avatarUrl: '' });
      }
    })
  );
  return map;
}

/**
 * Wire a long-press on `pill` that expands the thread (`onLongPress`) and
 * swallows the tap that would otherwise open the emoji pulldown. Touch-only, so
 * it's a no-op with a mouse. Solves the mobile case where the thin ">" toggle is
 * nearly impossible to hit with a finger — long-press anywhere on the pill.
 */
export function attachThreadLongPress(
  pill: HTMLElement,
  onLongPress: () => void
): void {
  let timer: number | null = null;
  let longPressed = false;
  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  pill.addEventListener(
    'touchstart',
    () => {
      longPressed = false;
      timer = window.setTimeout(() => {
        longPressed = true;
        onLongPress();
      }, 500);
    },
    { passive: true }
  );

  pill.addEventListener('touchend', e => {
    cancel();
    if (longPressed) {
      // Suppress the synthetic click so the pulldown doesn't also open.
      e.preventDefault();
      e.stopPropagation();
    }
  });

  pill.addEventListener('touchmove', cancel, { passive: true });
  pill.addEventListener('touchcancel', cancel);
}

async function reactWithSame(
  reaction: NostrEvent,
  targetNoteId: string,
  targetAuthor: string,
  targetEvent: NostrEvent | undefined,
  ctx: ReactionThreadContext
): Promise<void> {
  if (!AuthGuard.requireAuth('react to reaction')) return;
  const tag = customEmojiTag(reaction);
  await ctx.reactionsApi?.publishReaction({
    noteId: targetNoteId,
    authorPubkey: targetAuthor,
    emoji: sameEmojiContent(reaction),
    ...(targetEvent ? { targetEvent } : {}),
    ...(tag ? { emojiTag: tag } : {}),
  });
}

async function reactToReaction(
  reaction: NostrEvent,
  triggerEl: HTMLElement,
  ctx: ReactionThreadContext
): Promise<void> {
  if (!AuthGuard.requireAuth('react to reaction')) return;

  // Load the user's NIP-30 custom emoji pack when the addon is on, so the
  // picker shows the same Custom tab as the direct like flow (LikeManager).
  let customEmojis: CustomEmojiEntry[] | undefined;
  if (isCustomEmojisEnabled()) {
    try {
      const { EmojiService } = await import(
        '../addons/custom-emojis/EmojiService'
      );
      const service = EmojiService.getInstance();
      void service.refreshFromRelays();
      customEmojis = service.getEmojis();
    } catch (err) {
      console.debug('[reactionThreadView] Custom emoji load failed:', err);
    }
  }

  const { EmojiPicker } = await import('../components/emoji/EmojiPicker');
  const picker = new EmojiPicker({
    triggerElement: triggerEl,
    ...(customEmojis ? { customEmojis } : {}),
    onSelect: async emoji => {
      picker.destroy();
      await ctx.reactionsApi?.publishReaction({
        noteId: reaction.id!,
        authorPubkey: reaction.pubkey,
        emoji,
        targetEvent: reaction,
      });
    },
    onCustomSelect: async entry => {
      picker.destroy();
      await ctx.reactionsApi?.publishReaction({
        noteId: reaction.id!,
        authorPubkey: reaction.pubkey,
        emoji: `:${entry.shortcode}:`,
        emojiTag: ['emoji', entry.shortcode, entry.url],
        targetEvent: reaction,
      });
    },
  });
  picker.show();
}

/**
 * Build the emoji as a pulldown. `emojiHtml` is the emoji itself (wrapped in its
 * own `.reaction-menu__emoji` container); `extraHtml` is an optional sibling
 * rendered after it (e.g. the aggregated count on a top-level badge) — kept as a
 * separate element so emoji, count and the ">" toggle all align consistently.
 */
export function buildEmojiMenu(
  reaction: NostrEvent,
  targetNoteId: string,
  targetAuthor: string,
  targetEvent: NostrEvent | undefined,
  emojiHtml: string,
  ctx: ReactionThreadContext,
  extraHtml?: string
): HTMLElement {
  const dd = new CustomDropdown({
    options: [
      { value: 'same', label: 'Add the same emoji' },
      { value: 'to', label: 'React to this reaction' },
    ],
    selectedValue: '',
    className: 'reaction-menu',
    onChange: value => {
      if (value === 'same')
        void reactWithSame(
          reaction,
          targetNoteId,
          targetAuthor,
          targetEvent,
          ctx
        );
      else if (value === 'to')
        void reactToReaction(reaction, dd.getElement(), ctx);
    },
  });
  ctx.dropdowns.push(dd);

  const el = dd.getElement();
  const trigger = el.querySelector('.custom-dropdown__trigger');
  // Replace the whole trigger content (drops the default arrow) — the emoji IS
  // the affordance, exactly like the repost menu shows just its icon. Emoji and
  // the optional count each get their own element so they align cleanly.
  // (Off-screen flipping is handled centrally by CustomDropdown.positionMenu.)
  if (trigger)
    trigger.innerHTML = `<span class="reaction-menu__emoji">${emojiHtml}</span>${extraHtml ?? ''}`; // security-ok: emojiHtml escaped via reactionDisplayEmoji, extraHtml is a numeric count span
  return el;
}

/**
 * Recursively build the (initially collapsed) children container for a reaction.
 * Returns null when the reaction has no child reactions.
 */
export function buildChildrenContainer(
  parent: NostrEvent,
  ctx: ReactionThreadContext,
  depth = 0
): HTMLElement | null {
  const children = parent.id ? (ctx.tree.get(parent.id) ?? []) : [];
  if (children.length === 0 || depth >= MAX_RENDER_DEPTH) return null;

  const wrap = document.createElement('div');
  wrap.className = 'reaction-node__children';
  for (const child of children) {
    wrap.appendChild(buildNodeRow(child, parent, ctx, depth + 1));
  }
  return wrap;
}

/**
 * One tree row: [ "> " toggle | spacer ] [ emoji pulldown ] (username link).
 * `targetEvent` is what `reaction` reacted to (its parent), used for
 * "react with the same emoji".
 */
function buildNodeRow(
  reaction: NostrEvent,
  targetEvent: NostrEvent,
  ctx: ReactionThreadContext,
  depth: number
): HTMLElement {
  const node = document.createElement('div');
  node.className = 'reaction-node';

  const row = document.createElement('div');
  row.className = 'reaction-node__row';

  const grandChildren = buildChildrenContainer(reaction, ctx, depth);

  if (grandChildren) {
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

  row.appendChild(
    buildEmojiMenu(
      reaction,
      targetEvent.id!,
      targetEvent.pubkey,
      targetEvent,
      reactionDisplayEmoji(reaction),
      ctx
    )
  );

  const profile = ctx.profiles.get(reaction.pubkey) || {
    username: 'Anonymous',
    avatarUrl: '',
  };
  const user = document.createElement('span');
  user.className = 'reaction-node__user';
  user.innerHTML = `(${renderUserMention(reaction.pubkey, profile)})`; // security-ok: renderUserMention returns escaped, trusted markup
  row.appendChild(user);

  node.appendChild(row);
  if (grandChildren) node.appendChild(grandChildren);
  return node;
}
