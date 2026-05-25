import { NostrTransport } from '../../services/transport/NostrTransport';
import { RelayConfig } from '../../services/RelayConfig';
import { AuthService } from '../../services/AuthService';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { SearchModuleApi } from '../../modules/search/contracts';
import { NoteUI } from '../../components/ui/NoteUI';
import { resolvePubkey } from '../../helpers/resolvePubkey';
import type { NostrEvent, NDKFilter } from '@nostr-dev-kit/ndk';

const DEFAULT_POSTS_PER_PAGE = 5;

interface WeblogState {
  pubkey: string;
  hashtags: string[];
  includeWithoutHash: boolean;
  postsPerPage: number;
  excludeReplies: boolean;
  excludeReposts: boolean;
  oldestSeen: number; // unix seconds — `until` cursor for the next fetch
}

const slotState = new WeakMap<HTMLElement, WeblogState>();

/**
 * Mount each `<div data-weblog-mount>` slot with a paged list of the
 * author's kind-1 (and optionally kind-6 repost) notes, filtered by
 * hashtags. Renders via NoteUI so logged-in visitors get the full ISL.
 *
 * Pagination: load-more (single button at the bottom). State is kept
 * per slot in a WeakMap so re-renders of the page don't lose the cursor
 * — but a fresh DOM (e.g. after a NospressView re-render) starts over.
 */
export function mountNospressWeblogs(
  container: HTMLElement,
  opts: { ownerPubkey: string }
): void {
  const slots = container.querySelectorAll<HTMLElement>('[data-weblog-mount]');
  slots.forEach(slot => {
    void mountSlot(slot, opts.ownerPubkey);
  });
}

async function mountSlot(slot: HTMLElement, ownerPubkey: string): Promise<void> {
  const pubkey = resolvePubkey(slot.dataset.pubkey, ownerPubkey);
  if (!pubkey) {
    slot.innerHTML = `<p class="nospress-block-weblog__empty">No author resolved.</p>`;
    return;
  }

  const hashtags = parseHashtags(slot.dataset.hashtags);
  const includeWithoutHash = slot.dataset.includeWithoutHash === '1';
  const postsPerPage = clampInt(slot.dataset.postsPerPage, 1, 20, DEFAULT_POSTS_PER_PAGE);
  const excludeReplies = slot.dataset.excludeReplies !== '0';
  const excludeReposts = slot.dataset.excludeReposts === '1';

  const state: WeblogState = {
    pubkey,
    hashtags,
    includeWithoutHash,
    postsPerPage,
    excludeReplies,
    excludeReposts,
    oldestSeen: Math.floor(Date.now() / 1000),
  };
  slotState.set(slot, state);

  // Initial container scaffold: posts area + load-more bar. The
  // `.pulsate` placeholder sits inside `__items` until the first fetch
  // resolves; `fetchAndAppend` removes it before rendering the first
  // page (or the empty-state message). Subsequent load-more calls find
  // no placeholder so the removal is a no-op.
  slot.innerHTML = `
    <div class="nospress-block-weblog__items">
      <div class="nospress-block-weblog__loading pulsate">Loading posts…</div>
    </div>
    <div class="nospress-block-weblog__bar">
      <button type="button" class="btn btn--passive btn--medium nospress-block-weblog__load-more">Load more</button>
    </div>
  `;

  const loadMoreBtn = slot.querySelector<HTMLButtonElement>('.nospress-block-weblog__load-more');
  loadMoreBtn?.addEventListener('click', () => {
    void fetchAndAppend(slot, state, loadMoreBtn);
  });

  await fetchAndAppend(slot, state, loadMoreBtn);
}

async function fetchAndAppend(
  slot: HTMLElement,
  state: WeblogState,
  loadMoreBtn: HTMLButtonElement | null,
): Promise<void> {
  if (loadMoreBtn) loadMoreBtn.disabled = true;
  const itemsHost = slot.querySelector<HTMLElement>('.nospress-block-weblog__items');
  if (!itemsHost) return;

  try {
    const events = state.hashtags.length > 0
      ? await fetchByHashtagSearch(state)
      : await fetchByAuthor(state);

    if (!slot.isConnected) return;

    const filtered = filterEvents(events, state);
    filtered.sort((a, b) => b.created_at - a.created_at);
    const next = filtered.slice(0, state.postsPerPage);

    // First fetch completed — drop the initial loading placeholder so
    // the empty-state check + the note appends below work against a
    // clean items host. No-op on subsequent load-more calls.
    const loadingEl = itemsHost.querySelector('.nospress-block-weblog__loading');
    if (loadingEl) loadingEl.remove();

    if (next.length === 0) {
      if (itemsHost.children.length === 0) {
        itemsHost.innerHTML = `<p class="nospress-block-weblog__empty">No posts yet.</p>`;
      }
      if (loadMoreBtn) loadMoreBtn.style.display = 'none';
      return;
    }

    const isLoggedIn = AuthService.getInstance().getCurrentUser() !== null;
    for (const event of next) {
      const note = NoteUI.createNoteElement(event, {
        collapsible: true,
        islFetchStats: true,
        isLoggedIn,
        depth: 1,
      });
      itemsHost.appendChild(note);
    }

    state.oldestSeen = next[next.length - 1]!.created_at;

    if (filtered.length <= state.postsPerPage && loadMoreBtn) {
      loadMoreBtn.style.display = 'none';
    } else if (loadMoreBtn) {
      loadMoreBtn.disabled = false;
    }
  } catch (error) {
    console.error('Weblog mount failed:', error);
    const loadingEl = itemsHost.querySelector('.nospress-block-weblog__loading');
    if (loadingEl) loadingEl.remove();
    if (slot.isConnected && loadMoreBtn) loadMoreBtn.disabled = false;
  }
}

/**
 * No-hashtag path: classic author-scoped fetch from the user's read relays.
 * Reposts (kind 6) included unless excluded.
 */
async function fetchByAuthor(state: WeblogState): Promise<NostrEvent[]> {
  const relays = RelayConfig.getInstance().getReadRelays();
  const kinds = state.excludeReposts ? [1] : [1, 6];
  const filter: NDKFilter = {
    kinds,
    authors: [state.pubkey],
    until: state.oldestSeen,
    limit: state.postsPerPage * 2,
  };
  return NostrTransport.getInstance().fetch(relays, [filter], 8000, false, 'NospressWeblog');
}

/**
 * Hashtag path: NIP-50 search via SearchOrchestrator (kind 1 only — search
 * relays don't reliably index reposts). Per-hashtag search calls run in
 * parallel and are merged + deduplicated.
 *
 * Mirrors the HashtagSubscriptions addon strategy: use search relays
 * because plain `#t`-tag filters on user relays miss notes whose tags are
 * cased differently than the query, and miss content-only mentions.
 * Client-side verification (case-insensitive) follows in `filterEvents`.
 */
async function fetchByHashtagSearch(state: WeblogState): Promise<NostrEvent[]> {
  const search = ModuleLoader.getInstance().getApi<SearchModuleApi>('search');
  const limit = state.postsPerPage * 4; // generous, post-filter narrows it
  const queries: string[] = [];
  for (const tag of state.hashtags) {
    queries.push(`#${tag}`);
    if (state.includeWithoutHash) queries.push(tag);
  }
  const results = await Promise.all(
    queries.map(q =>
      search?.searchPaginated(
        { query: q, authors: [state.pubkey], limit },
        state.oldestSeen,
      )?.catch(() => [] as NostrEvent[]) ?? Promise.resolve([] as NostrEvent[]),
    ),
  );

  const seen = new Set<string>();
  const merged: NostrEvent[] = [];
  for (const events of results) {
    for (const ev of events) {
      if (!ev.id || seen.has(ev.id)) continue;
      seen.add(ev.id);
      merged.push(ev);
    }
  }
  return merged;
}

function filterEvents(events: NostrEvent[], state: WeblogState): NostrEvent[] {
  const lowerTags = state.hashtags.map(t => t.toLowerCase());
  return events.filter(event => {
    if (event.created_at >= state.oldestSeen) return false; // already shown

    // Hashtag verification: search relays return fuzzy matches, so check
    // each hit actually carries the hashtag (case-insensitive) either
    // as a `#t` tag, as `#hashtag` text, or — when includeWithoutHash is
    // on — as a plain occurrence of the term inside the content.
    if (lowerTags.length > 0) {
      const tags = event.tags ?? [];
      const content = (event.content ?? '').toLowerCase();
      const matches = lowerTags.some(tag => {
        const inTag = tags.some(t => t[0] === 't' && t[1]?.toLowerCase() === tag);
        const inContent = content.includes(`#${tag}`);
        const inContentBare = state.includeWithoutHash && content.includes(tag);
        return inTag || inContent || inContentBare;
      });
      if (!matches) return false;
    }

    if (state.excludeReplies) {
      const isReply = event.tags.some(t => t[0] === 'e' || t[0] === 'a');
      if (event.kind === 1 && isReply) return false;
    }
    return true;
  });
}

function parseHashtags(raw: string | undefined): string[] {
  return (raw || '')
    .split(',')
    .map(s => s.trim().replace(/^#/, '').toLowerCase())
    .filter(Boolean);
}

function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  const n = parseInt((raw || '').trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
