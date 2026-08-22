/**
 * Pure freshness rules for FOAF cache entries (memory + IndexedDB restore).
 *
 * Extracted from FoafService so the rules are testable without pulling the
 * transport/auth dependency graph. FoafService.apply's both to its in-memory
 * cache and to FoafStore restores — they MUST stay the same rules.
 */

/** 24h safety TTL — a graph older than this is rebuilt. */
export const FOAF_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Follow-count divergence tolerated before a cached graph is considered
 * stale. The graph is a discovery approximation, not correctness-critical
 * data: ±20 follows out of ~400 change which authors COULD appear in a
 * degree-2 feed by a fraction of a percent — but a strict === check
 * discarded an otherwise fresh 28k-pubkey graph (measured: AutoSync
 * completing one follow after the build → full 40s rebuild on next load).
 * Tolerance is measured against the graph's ORIGINAL build count, so it
 * never accumulates across sessions (no re-save of restored entries).
 */
export const foafFollowCountTolerance = (
  buildCount: number,
  currentCount: number
): number => Math.max(20, Math.ceil(0.05 * Math.max(buildCount, currentCount)));

/**
 * A cache entry is fresh when (a) the user's follow count hasn't diverged
 * beyond the tolerance from the count the graph was built with, and (b) it
 * was built within the TTL. `now` is injectable for tests.
 */
export const isFoafEntryFresh = (
  followCountAtBuild: number,
  builtAt: number,
  currentFollowCount: number,
  now: number = Date.now()
): boolean =>
  Math.abs(followCountAtBuild - currentFollowCount) <=
    foafFollowCountTolerance(followCountAtBuild, currentFollowCount) &&
  now - builtAt < FOAF_CACHE_TTL_MS;
