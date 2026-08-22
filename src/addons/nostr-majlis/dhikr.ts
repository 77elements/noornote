/**
 * Community Dhikr (M3) - event model + helpers.
 *
 * NoorNote-defined community events on a FIXED, hardcoded relay pair (DHIKR_RELAYS). This addon
 * NEVER uses the user's relays, the aggregated relays or outbox - ONLY these two, for both
 * publishing and subscribing. Only NoorNote renders these events.
 *
 * Built on kind 30078 (NIP-78 addressable app data), the same mechanism note-taking uses:
 *   - Round (a dhikr action): d=`noornote/dhikr/<uuid>`, t=`noornote-dhikr-round` (discovery),
 *     title/goal/description tags.
 *   - Commit (a participation): a=<round addr>, t=`noornote-dhikr-commit`, count tag. One per npub
 *     per round (replaceable → the user's running total); anonymous commits use a one-time key, so
 *     each anonymous submission is its own event. Either way the round total = sum of all commits.
 *
 * Progress = sum of all commit counts for a round; goal reached when sum >= goal. Soft /
 * eventually-consistent: each client sums what the two relays return it.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';

// HARDCODED: the only relays this addon ever touches. No outbox, no aggregated, no user relays.
export const DHIKR_RELAYS = [
  'wss://noornode.nostr1.com',
  'wss://bitcoinmajlis.nostr1.com',
];

export const DHIKR_KIND = 30078;
export const ROUND_LABEL = 'noornote-dhikr-round';
export const COMMIT_LABEL = 'noornote-dhikr-commit';
const ROUND_D_PREFIX = 'noornote/dhikr/';
const COMMIT_D_PREFIX = 'noornote/dhikr/commit/';

/** An unsigned event draft (no pubkey/id/sig yet); DhikrService signs + publishes it. */
export interface DraftEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface DhikrRound {
  uuid: string; // round id (suffix of the d-tag)
  addr: string; // `30078:<pubkey>:<dtag>` addressable ref
  author: string; // pubkey
  phrase: string;
  goal: number;
  description: string;
  createdAt: number;
}

export interface DhikrCommit {
  author: string; // pubkey (real or one-time)
  dtag: string; // dedup key together with author
  roundAddr: string;
  count: number;
  createdAt: number;
}

function tagValue(ev: NostrEvent, name: string): string | undefined {
  return ev.tags.find(t => t[0] === name)?.[1];
}

/** The signed-in user's stable (replaceable) commit d-tag for a round. */
export function stableCommitDtag(round: DhikrRound): string {
  return `${COMMIT_D_PREFIX}${round.uuid}`;
}

/** Parse a kind-30078 round event, or null if it isn't a well-formed dhikr round. */
export function parseRound(ev: NostrEvent): DhikrRound | null {
  const d = tagValue(ev, 'd');
  if (!d || !d.startsWith(ROUND_D_PREFIX) || d.startsWith(COMMIT_D_PREFIX))
    return null;
  const phrase = tagValue(ev, 'title');
  const goalStr = tagValue(ev, 'goal');
  if (!phrase || !goalStr) return null;
  const goal = parseInt(goalStr, 10);
  if (!Number.isFinite(goal) || goal <= 0) return null;
  return {
    uuid: d.slice(ROUND_D_PREFIX.length),
    addr: `${DHIKR_KIND}:${ev.pubkey}:${d}`,
    author: ev.pubkey,
    phrase,
    goal,
    description: tagValue(ev, 'description') || '',
    createdAt: ev.created_at,
  };
}

/** Parse a kind-30078 commit event, or null. */
export function parseCommit(ev: NostrEvent): DhikrCommit | null {
  const a = tagValue(ev, 'a');
  const d = tagValue(ev, 'd');
  const countStr = tagValue(ev, 'count');
  if (!a || !d || !countStr) return null;
  const count = parseInt(countStr, 10);
  if (!Number.isFinite(count) || count < 0) return null;
  return {
    author: ev.pubkey,
    dtag: d,
    roundAddr: a,
    count,
    createdAt: ev.created_at,
  };
}

/** Build the unsigned round event (signing + publishing done by DhikrService). */
export function buildRoundDraft(
  phrase: string,
  goal: number,
  description: string
): DraftEvent {
  const uuid = crypto.randomUUID();
  const tags: string[][] = [
    ['d', ROUND_D_PREFIX + uuid],
    ['t', ROUND_LABEL],
    ['title', phrase],
    ['goal', String(goal)],
  ];
  if (description) tags.push(['description', description]);
  return {
    kind: DHIKR_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
}

/** Build the unsigned commit event: stable d per round → replaceable, so the count accumulates. */
export function buildCommitDraft(round: DhikrRound, count: number): DraftEvent {
  const tags: string[][] = [
    ['d', stableCommitDtag(round)],
    ['t', COMMIT_LABEL],
    ['a', round.addr],
    ['count', String(count)],
  ];
  return {
    kind: DHIKR_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
}
