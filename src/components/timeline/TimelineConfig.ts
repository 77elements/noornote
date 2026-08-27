/**
 * TimelineConfig — the single, typed description of a timeline use case.
 *
 * The Timeline component serves many use cases (main timeline, profile, tribes,
 * relay-filtered, time-machine). Instead of scattering `if (isProfileView)` /
 * `if (filterAuthorPubkey)` checks across the data/lifecycle/pagination/DOM
 * layers (and re-deriving the use case from structural accidents like
 * `followingPubkeys.length === 1`), every caller hands in ONE config and the
 * component is driven entirely by it. Common denominators (mute/reply/word/dedup
 * /sort) stay central; the config only toggles inputs.
 *
 * Status: fully consumed. Timeline reads source/relays/range via the readers
 * below (relayFilterUrl / timeRangeOf) and every boolean field directly.
 * Enforced by /build-validate Step 25 (Timeline Architecture Guard).
 *
 * Behavior matrix + guard mapping: docs/todos/timeline-component-modularization.md
 */

import { isDataSaverEnabled } from '../../services/DataSaverService';
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../services/PerAccountLocalStorage';

export type FeedMode = 'latest' | 'latest-replies';

/** The main timeline's remembered feed mode (Latest vs Latest + Replies), restored on startup. */
export function getSavedFeedMode(): FeedMode {
  const v = PerAccountLocalStorage.getInstance().get<string>(
    StorageKeys.TIMELINE_VIEW,
    'latest'
  );
  return v === 'latest-replies' ? 'latest-replies' : 'latest';
}

export function saveFeedMode(mode: FeedMode): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.TIMELINE_VIEW, mode);
}

/** WHO the feed is for. */
export type TimelineSource =
  | { kind: 'following' } // the current user's follow list (+ self)
  | { kind: 'authors'; pubkeys: string[] }; // explicit author(s): profile (1) / tribe (n)

/** WHERE to fetch from. */
export type TimelineRelays =
  | { kind: 'auto' } // combined read + outbox + aggregator union
  | { kind: 'author-outbox' } // the author's own NIP-65 write relays (capped)
  | { kind: 'explicit'; urls: string[] }; // a specific relay set (relay timeline)

/** WHEN — live (newest, pollable) vs a fixed window (time-machine). */
export type TimelineRange =
  | { kind: 'live' }
  | { kind: 'between'; since: number; until: number };

export interface TimelineConfig {
  source: TimelineSource;
  relays: TimelineRelays;
  range: TimelineRange;
  /** Include reply notes (user-toggleable at runtime; this is the initial value). */
  includeReplies: boolean;
  /** 'direct' = raw-WS clean fetch (gap-free, ProfileView); 'cache-first' = NDK cache fetch. */
  fetchMode: 'cache-first' | 'direct';
  /** 'until' = pure cursor pagination; 'window' = timeWindowHours chunks. */
  pagination: 'window' | 'until';
  pageSize: number;
  /** Poll for new notes (only meaningful for live ranges). */
  polling: boolean;
  /** Trim the DOM/state at a ceiling (false = keep full history, e.g. ProfileView). */
  trimDom: boolean;
  /** Inject marketplace listings (main timeline only). */
  marketplaceInjection: boolean;
  /** Pubkey not muted in its own feed (the profile owner). */
  muteExemptPubkey?: string;
  /** Apply the content word-filter addon. */
  applyWordFilter: boolean;
  /**
   * When the user follows nobody (following source, list <= self), fall back to
   * the curated starter feed + a friendly banner instead of an error. Main
   * timeline only — profile/tribe/relay-filter views keep the empty error.
   */
  curatedFallbackWhenEmpty?: boolean;
  /**
   * Size of one loadMore time chunk in hours. Default (when unset): 3 for
   * windowed feeds, 720 for author-outbox (ProfileView). Tribes set 720 so a
   * multi-day posting gap is crossed in ONE non-empty chunk instead of
   * recursing through dozens of empty 3h windows (each an extra relay fetch).
   */
  loadMoreWindowHours?: number;
  /**
   * How far back loadMore may search through empty chunks before declaring the
   * feed exhausted (measured from NOW, in hours). Default 168 (7 days) — the
   * historical hardcode. Tribes raise this to ~4 years (effectively endless);
   * the 56-recursion cap per scroll still bounds relay cost.
   */
  historyDepthHours?: number;
}

/**
 * Build the config for the three current constructor entry points, reproducing
 * today's behavior exactly. Relay-filter and time-machine are still applied via
 * runtime state setters and get folded into the config in a later phase.
 */
export function buildTimelineConfig(
  filterAuthorPubkey: string | undefined,
  tribePubkeys: string[] | undefined
): TimelineConfig {
  const defaultPageSize = isDataSaverEnabled() ? 20 : 50;

  // ProfileView: single author. Gap-free direct fetch (raw WS), pure `until`,
  // larger page, full history (no trim). Relays = 'auto' (the broad read +
  // aggregator union, the same set the main timeline uses) so the PV always
  // loads even when the author's own NIP-65 relays are dead or sparse;
  // author-outbox alone left profiles empty after the rebuild.
  if (filterAuthorPubkey) {
    return {
      source: { kind: 'authors', pubkeys: [filterAuthorPubkey] },
      relays: { kind: 'auto' },
      range: { kind: 'live' },
      includeReplies: false,
      fetchMode: 'direct',
      pagination: 'until',
      pageSize: isDataSaverEnabled() ? 100 : 200,
      polling: true,
      trimDom: false,
      marketplaceInjection: false,
      muteExemptPubkey: filterAuthorPubkey,
      applyWordFilter: false,
    };
  }

  // TribeView: explicit author set. 30-day loadMore chunks + ~4 years depth:
  // tribe members post sparsely; with 3h windows the empty-chunk recursion
  // burned a relay fetch per window and hit the 7-day wall even though older
  // posts exist (proven via loadMore diagLog, 2026-08-27).
  if (tribePubkeys && tribePubkeys.length > 0) {
    return {
      source: { kind: 'authors', pubkeys: tribePubkeys },
      relays: { kind: 'auto' },
      range: { kind: 'live' },
      includeReplies: false,
      fetchMode: 'cache-first',
      pagination: 'window',
      pageSize: defaultPageSize,
      polling: true,
      trimDom: true,
      marketplaceInjection: false,
      applyWordFilter: true,
      loadMoreWindowHours: 720,
      historyDepthHours: 35040,
    };
  }

  // Main timeline (TV): the user's follow list. Replies preference is remembered across restarts.
  return {
    source: { kind: 'following' },
    relays: { kind: 'auto' },
    range: { kind: 'live' },
    includeReplies: getSavedFeedMode() === 'latest-replies',
    fetchMode: 'cache-first',
    pagination: 'window',
    pageSize: defaultPageSize,
    polling: true,
    trimDom: true,
    marketplaceInjection: true,
    applyWordFilter: true,
    curatedFallbackWhenEmpty: true,
  };
}

// Named factories — the API views use to express intent ("for this user", "for
// these users", "my follows"). They wrap buildTimelineConfig so the per-use-case
// defaults live in one place.

/** ProfileView: a single author's complete, gap-free feed. */
export function profileTimelineConfig(authorPubkey: string): TimelineConfig {
  return buildTimelineConfig(authorPubkey, undefined);
}

/** TribeView / tribe tab: the notes of an explicit set of users. */
export function tribeTimelineConfig(memberPubkeys: string[]): TimelineConfig {
  return buildTimelineConfig(undefined, memberPubkeys);
}

/** Main timeline: the current user's follow list. */
export function followingTimelineConfig(): TimelineConfig {
  return buildTimelineConfig(undefined, undefined);
}

// Runtime overrides (relay filter / time-machine) live in the config too, so it
// stays the single source of truth for the feed. These read them back out.

/** The single relay a relay-filtered feed is pinned to, or null. */
export function relayFilterUrl(c: TimelineConfig): string | null {
  return c.relays.kind === 'explicit' ? (c.relays.urls[0] ?? null) : null;
}

/** The selected time-machine window, or null when live. */
export function timeRangeOf(
  c: TimelineConfig
): { since: number; until: number } | null {
  return c.range.kind === 'between'
    ? { since: c.range.since, until: c.range.until }
    : null;
}
