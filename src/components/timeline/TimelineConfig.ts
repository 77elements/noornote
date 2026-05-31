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
 * Migration plan + behavior matrix: docs/todos/timeline-component-modularization.md
 *
 * Phase 0: this type + buildTimelineConfig() exist and the Timeline constructor
 * builds a config, but nothing downstream consumes it yet (behavior-preserving).
 */

import { isDataSaverEnabled } from '../../services/DataSaverService';

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

  // ProfileView: single author — gap-free direct fetch over author-outbox relays,
  // pure `until`, larger page, full history (no trim). See the 2026-05-31 fixes.
  if (filterAuthorPubkey) {
    return {
      source: { kind: 'authors', pubkeys: [filterAuthorPubkey] },
      relays: { kind: 'author-outbox' },
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

  // TribeView: explicit author set.
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
    };
  }

  // Main timeline (TV): the user's follow list.
  return {
    source: { kind: 'following' },
    relays: { kind: 'auto' },
    range: { kind: 'live' },
    includeReplies: false,
    fetchMode: 'cache-first',
    pagination: 'window',
    pageSize: defaultPageSize,
    polling: true,
    trimDom: true,
    marketplaceInjection: true,
    applyWordFilter: true,
  };
}
