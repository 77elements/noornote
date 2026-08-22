/**
 * Follow-pack member activity sorting.
 *
 * Sorts a rendered pack member list so the most recently active people are on
 * top and the least active (or silent) are at the bottom. "Active" = the newest
 * kind:1 event (a post or a reply) the user's read relays carry for that author.
 *
 * Progressive by design: the caller renders the list in pack order first, then
 * hands the list here to be re-sorted once the activity data arrives — so the
 * list never blocks on a relay round-trip.
 *
 * The activity map is cached in memory for the session only (a NoorNote restart
 * re-determines it, since this module state is gone). A member with no kind:1
 * event in the fetched window is treated as activity 0 → sorts to the bottom.
 */

import { fetchEvents } from '../../lists/relays';
import { ToastService } from '../../services/ToastService';
import { diagLog } from '../../services/DiagnosticLogger';
import { formatTimeAgo } from '../../helpers/formatTimeAgo';

/** Only content activity counts — a new post or reply (both kind:1). */
const ACTIVITY_KINDS = [1];
/** Upper bound on events pulled in the single batched query. Enough to capture
 *  each active author's latest across a normal-sized pack; quieter authors in
 *  very large packs may fall outside the window and sort as inactive. */
const ACTIVITY_LIMIT = 500;

/** Session cache: pubkey → newest kind:1 created_at (0 = queried but silent). */
const activityCache = new Map<string, number>();

/**
 * Resolve last-activity timestamps for the given pubkeys, using the session
 * cache and a single batched relay query for the uncached remainder.
 * Returns the full map plus whether a network fetch actually happened.
 */
async function getLastActivityMap(
  pubkeys: string[]
): Promise<{ map: Map<string, number>; fetched: boolean }> {
  const missing = pubkeys.filter(pk => !activityCache.has(pk));

  if (missing.length > 0) {
    try {
      const events = await fetchEvents([
        { authors: missing, kinds: ACTIVITY_KINDS, limit: ACTIVITY_LIMIT },
      ]);
      for (const ev of events) {
        const at = ev.created_at ?? 0;
        if (at > (activityCache.get(ev.pubkey) ?? 0))
          activityCache.set(ev.pubkey, at);
      }
      // Mark queried-but-silent authors so they aren't re-queried this session.
      for (const pk of missing)
        if (!activityCache.has(pk)) activityCache.set(pk, 0);
    } catch {
      // Leave them uncached → treated as 0 below; a later open retries.
    }
  }

  const map = new Map<string, number>();
  for (const pk of pubkeys) map.set(pk, activityCache.get(pk) ?? 0);
  return { map, fetched: missing.length > 0 };
}

/**
 * Re-order the member rows inside `list` by recent activity (newest first).
 * Fire-and-forget from the renderer. Shows a one-off toast when it had to fetch
 * activity data (i.e. not on a warm-cache re-open, to avoid toast spam).
 */
export async function sortMemberRowsByActivity(
  list: HTMLElement,
  pubkeys: string[]
): Promise<void> {
  if (pubkeys.length < 2) return;

  const { map: activity, fetched } = await getLastActivityMap(pubkeys);
  if (![...activity.values()].some(ts => ts > 0)) return; // nothing to sort by

  const items = Array.from(
    list.querySelectorAll('.follow-packs__member-item')
  ) as HTMLElement[];
  if (items.length < 2) return;

  // Stamp each row with "last active: …" next to the name. created_at is unix
  // seconds; formatTimeAgo expects milliseconds. Silent members (0) show nothing.
  for (const el of items) {
    const ts = activity.get(el.dataset.pubkey || '') ?? 0;
    const slot = el.querySelector('[data-activity]');
    if (slot)
      slot.textContent =
        ts > 0 ? `last active: ${formatTimeAgo(ts * 1000)}` : '';
  }

  const byActivity = (a: HTMLElement, b: HTMLElement) =>
    (activity.get(b.dataset.pubkey || '') ?? 0) -
    (activity.get(a.dataset.pubkey || '') ?? 0);

  const sorted = [...items].sort(byActivity);
  // Reorder only when the order actually changes (warm-cache re-open may match).
  if (!items.every((el, i) => el === sorted[i])) {
    if (fetched)
      ToastService.show('Sorting members by recent activity…', 'info');
    for (const el of sorted) list.appendChild(el);
  }

  diagLog('system', 'follow_pack_activity_sort', {
    members: pubkeys.length,
    active: [...activity.values()].filter(ts => ts > 0).length,
  });
}
