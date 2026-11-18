/**
 * Focus dependency graph (v2) — the SINGLE SOURCE OF TRUTH for object
 * dependencies.
 *
 * Consumers (each must read THIS module, never re-declare edges):
 * 1. Hidden objects (shell/hiddenObjectsStore.ts): the hide button is not
 *    rendered while a visible domain requires the object — docs/todos/
 *    hidden-objects.md.
 * 2. Dev load expectations (services/DevLoadExpectations.ts): hidden
 *    objects shrink the budgets/origins the guard measures; dependency
 *    edges explain WHY an object's machinery must stay loaded while its
 *    requirers are visible.
 *
 * Rule (user-approved 2026-11-18): an object is hideable only while NO
 * visible object requires it. `profile` is locked — as long as someone
 * logs into NoorNote, they have a profile. Notifications are dynamically
 * locked: every visible object whose content can be interacted with via
 * the ISL (like/repost/zap) needs them.
 *
 * PURE module — no imports beyond types, so unit tests run without the
 * surface graph. Callers pass the full registry id list (the store reads
 * it from FOCUS_DOMAINS); edge-less domains stay first-class citizens.
 * The human-readable mirror lives in docs/todos/dependency-graph.md:
 * change the graph HERE and in the SAME commit update that file.
 */

/** Domains that must never be hidden (id → reason). */
export const LOCKED_DOMAINS: Readonly<Record<string, string>> = {
  // Login/identity — every feature needs an account; a logged-in user
  // always has a profile.
  profile: 'Login/identity — every feature needs an account',
};

/**
 * Dependency edges: domain id → the ids it needs VISIBLE to function.
 * Domains not listed have no requirements beyond themselves.
 *
 * Edge rationale (full table: docs/todos/dependency-graph.md):
 * - interactive objects (ISL: like/repost/zap, stream comments) →
 *   notifications
 * - recipes cards morph to articles → articles
 * - social filter/list machinery → follows, muted
 * - tribes membership = follow lists → follows
 *
 * MANDATORY (not an edge — every domain needs it unconditionally):
 * profile. Login/identity is a precondition of the whole app, so profile
 * is LOCKED (never hideable) instead of being a graph edge — keeping it
 * out of the arrays documents that no hide decision ever depends on it.
 */
export const FOCUS_DOMAIN_REQUIRES: Readonly<
  Record<string, readonly string[]>
> = {
  social: ['notifications', 'follows', 'muted'],
  articles: ['notifications'],
  media: ['notifications'],
  recipes: ['notifications', 'articles'],
  tribes: ['follows'],
  marketplace: ['notifications'],
  // live-streams (with reservations): streams can be commented on and
  // those replies replied to (zap.stream behavior — client support
  // unverified). If stream replies prove to not exist in practice, the
  // edge can be dropped.
  'live-streams': ['notifications'],
  // Remaining addon objects (custom-emojis, note-taking, scheduled-posts,
  // analytics, badges, feedback-board, hashtag-subscriptions, bulk-delete,
  // majlis, follower-notification, group-chats, wallet-balance,
  // word-filter): no edges — solo objects.
};

/** Pure: the ids currently visible = registry minus hidden (locked ids
 *  can never be hidden — sanitized upstream). */
export function visibleDomainIds(
  allDomainIds: readonly string[],
  hiddenIds: readonly string[]
): string[] {
  return allDomainIds.filter(id => !hiddenIds.includes(id));
}

/**
 * Pure: the domain's hide affordance visibility for a given hidden set —
 * not rendered (false) while a visible domain requires the object or the
 * object is locked/already hidden.
 */
export function canHideObject(
  id: string,
  allDomainIds: readonly string[],
  hiddenIds: readonly string[]
): boolean {
  if (id in LOCKED_DOMAINS) return false;
  if (hiddenIds.includes(id)) return false;
  return !visibleDomainIds(allDomainIds, hiddenIds).some(visible =>
    FOCUS_DOMAIN_REQUIRES[visible]?.includes(id)
  );
}

/**
 * Pure: validate a stored hidden set — unknown ids dropped, locked
 * domains dropped, ids required by a visible object dropped (stale
 * storage can never create an invalid visible/hidden combination; the UI
 * prevents it, this enforces it).
 */
export function sanitizeHiddenIds(
  allDomainIds: readonly string[],
  stored: unknown
): string[] {
  if (!Array.isArray(stored)) return [];
  const hidden = stored.filter(
    (id): id is string =>
      typeof id === 'string' &&
      allDomainIds.includes(id) &&
      !(id in LOCKED_DOMAINS)
  );
  // Iterate: dropping a hidden id may free another one (its requirer just
  // became hidden) — the set must converge to a valid state.
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...hidden]) {
      const blockedBy = visibleDomainIds(allDomainIds, hidden).find(visible =>
        FOCUS_DOMAIN_REQUIRES[visible]?.includes(id)
      );
      if (blockedBy) {
        hidden.splice(hidden.indexOf(id), 1);
        changed = true;
      }
    }
  }
  return hidden;
}
