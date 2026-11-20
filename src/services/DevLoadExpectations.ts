/**
 * Dev-only load guard — the committed "expected outcome" contract.
 *
 * Every feature that starts a timer, a relay subscription, or an addon at
 * login MUST declare its expected outcome here (budget += 1, a pattern in
 * `knownIntervalOrigins`, an on-demand id, …) — WITH a reason. The guard
 * compares a live `DevLoadSnapshot` (from DevLoadMonitor, dev builds only)
 * against this file and reports every undeclared deviation as a violation.
 *
 * Rule of engagement:
 *   - Guard FAILS  → either fix the leak, or update this file in the same
 *     commit with a justification comment. Raising a budget to silence a
 *     failure without a reason is not a fix.
 *   - Guard WARNS  → the deviation is legitimate while the gated surface is
 *     visible (widget on stage), cannot be verified programmatically — human
 *     eyes confirm or adjust the run.
 *
 * Imported ONLY by DevLoadMonitor (itself dev-only, dynamically imported
 * under `import.meta.env.DEV`) and its tests — production bundles never
 * ship this module.
 *
 * @see .opencode/skills/load-guard/SKILL.md (the /build-validate step that runs it)
 */

import type { DevLoadSnapshot } from './DevLoadMonitor';
import { HIDDEN_ADDON_DOMAINS } from '../shell/hiddenAddonDomains';

/**
 * Why an interval / subscription / addon is allowed to exist under the v2
 * (Focus UI) shell. Documented in the entry, echoed by the guard on failure.
 */
export interface ExpectationReason {
  /** Machine-readable pattern (substring of the stack origin / id). */
  pattern: string;
  /** WHY this is running — feature + classification (always-on vs on-demand). */
  reason: string;
  /** Maximum concurrent instances of this pattern (default 0 = unknown). */
  max?: number;
}

export interface DevLoadExpectations {
  /**
   * The guard is meaningful only while the v2 shell is the APPLIED interface.
   * With v1 active the classic machinery is allowed to run — a guard run on a
   * v1 surface reports the mismatch instead of false-positive violations.
   */
  requiresFocusUi: true;

  /** Total concurrent intervals at clean v2 boot (v1-off baseline). */
  maxIntervals: number;
  /** Expected interval origins with per-pattern caps — deviation = violation. */
  knownIntervalOrigins: ExpectationReason[];
  /**
   * Content-scoped / transient origins — they count against their OWN cap,
   * not against `maxIntervals` (their number depends on rendered content and
   * in-flight fetches, not on boot machinery). Cap exceeded = violation.
   * Measured on the reference account (v2, /-route and restored-/profile):
   * rendering timers (ContentProcessor, NoteStructureBuilder, …) stay
   * constant with content; fetch-timeout timers (fetchCore,
   * FeedOrchestrator.poll bursts, BookingService) self-clear after EOSE.
   */
  transientIntervalOrigins: ExpectationReason[];
  /** v1 machinery that must never schedule an interval under v2. */
  forbiddenIntervalOrigins: ExpectationReason[];

  /** Addons that may load at login under v2 (always-on / boot reasons). */
  maxAddons: number;
  /** On-demand addons — loaded at boot under v2 = violation. */
  onDemandAddonIds: string[];
  /** Widget-gated addons — loaded without their widget visible = warning. */
  widgetGatedAddonIds: string[];

  /** Relay subscriptions that are part of the always-on diodes. */
  allowedRelaySubscriptionIds: string[];
  /** Widget-gated subscriptions — without the widget visible = warning. */
  widgetGatedRelaySubscriptionIds: string[];

  /** v1 primary content must not mount children while v2 is active. */
  maxPrimaryContentChildren: number;

  /**
   * Hidden-state deltas (Phase 6, hidden objects): the addon registry ids
   * of the user's HIDDEN addon objects. A hidden addon loaded anyway = a
   * RAM-principle violation (its machinery must be switched off —
   * shell/domainShutdown.ts does exactly that on hide).
   */
  hiddenAddonIds?: string[];
}

/**
 * THE CONTRACT — maintained per feature, measured on the reference account
 * (clean v2 boot, ~18 s after login). Update with justification only.
 */
export const DEV_LOAD_EXPECTATIONS: DevLoadExpectations = {
  requiresFocusUi: true,

  // 22 = main.ts ×2, AddonLoader.runInit ×7, NostrTransport (prune) ×1,
  // PostLoginService.handleLogin ×3, BookmarkReadStateService ×1 (diode:
  // cross-device read markers), 8 NDK per-connection monitors + 8 anonymous
  // module-layer timers (DM ×2, Notifications ×1, Reactions ×2, Feed ×1,
  // DiagLogger ×2). The 7th addon job (2026-11-19): the reference account
  // enabled more user addons since calibration (calendar / marketplace /
  // follow-packs family) — addon background intervals scale with the
  // user's addon toggles, every running job has an always-on reason.
  // +3 (2026-11-19): the group-chats always-on poller starts ~25–30 s
  // AFTER login (delayed by design) — GroupChatsService.tick ×1 +
  // GroupChatsGroupClient fetch loops ×2 — and were below the original
  // ~18 s calibration window.
  maxIntervals: 25,
  knownIntervalOrigins: [
    {
      pattern: 'main.ts',
      reason: 'App boot timers (sync list, interface switch observer)',
      max: 2,
    },
    {
      pattern: 'AddonLoader',
      reason:
        'Addon runtime background jobs (always-on reasons only; count ' +
        'scales with user-enabled addons — 7th job from the newly ' +
        'enabled calendar/marketplace/follow-packs family)',
      max: 7,
    },
    {
      pattern: 'NostrTransport.doConnect',
      reason: 'Relay pool prune (12 s) — single instance by design',
      max: 1,
    },
    {
      pattern: 'PostLoginService',
      reason:
        'Login-sync timers (custom emojis / petnames / soft-mutes, NIP-78)',
      max: 3,
    },
    {
      pattern: 'BookmarkReadStateService',
      reason: 'Bookmark diode — cross-device unread read markers (NIP-78)',
      max: 1,
    },
    {
      // File-based pattern: origins are file:line since the monitor
      // attribution fix — function names never appear in them.
      pattern: 'GroupChatsService',
      reason: 'Group-chats addon poller (always-on while user-enabled)',
      max: 1,
    },
    {
      pattern: 'GroupChatsGroupClient',
      reason: 'Per-group client fetch loops (always-on while user-enabled)',
      max: 2,
    },
  ],
  transientIntervalOrigins: [
    {
      pattern: 'ContentProcessor',
      reason: 'Content-scoped timers per rendered note (references/embeds)',
      max: 6,
    },
    {
      pattern: 'NoteStructureBuilder',
      reason: 'Media fallback timers per rendered note structure',
      max: 6,
    },
    {
      pattern: 'QuotedNoteRenderer',
      reason: 'Quote-box timers per rendered quote',
      max: 3,
    },
    {
      pattern: 'UserProfileService',
      reason: 'Profile-fetch timers per rendered author',
      max: 4,
    },
    {
      pattern: 'focusStage',
      reason: 'v2 shell timers for mounted surfaces',
      max: 3,
    },
    {
      pattern: 'setTimeout.wrapped',
      reason: 'Deferred setup timers (setTimeout cb that installs an interval)',
      max: 6,
    },
    {
      pattern: 'fetchCore',
      reason: 'NDK fetch timeouts — transient, self-clear after response',
      max: 8,
    },
    {
      pattern: 'FeedOrchestrator.poll',
      reason: 'Poll burst (per-source fetch timeouts during one poll cycle)',
      max: 10,
    },
    {
      pattern: 'BookingService',
      reason: 'Calendar booking-config fetch timeouts (self-clear)',
      max: 8,
    },
    {
      pattern: 'FollowerCountService',
      reason: 'Followers pagination fetch timers (self-clear)',
      max: 4,
    },
    {
      pattern: 'QuoteOrchestrator',
      reason: 'Quote fetch timeouts (self-clear)',
      max: 4,
    },
    {
      pattern: 'ndk-cache-dexie',
      reason: 'Upstream NDK cache dump timer (maxSize > 0)',
      max: 2,
    },
  ],
  forbiddenIntervalOrigins: [
    {
      pattern: 'AutoSyncService',
      reason:
        'v1 list machinery — stopped under v2 (list storage: browser-only)',
    },
    {
      pattern: 'ArticleNotificationService',
      reason: 'v1 article notifications — stopped under v2',
    },
    // NOTE: there is deliberately NO forbidden pattern for loadListManagers:
    // the v1 sidebar managers themselves create no intervals, and the ONLY
    // interval reachable through that chain is the BookmarkReadStateService
    // diode (started at login, whitelisted above, deliberately NOT stopped
    // by teardownClassicListManagers — see MainLayout). A pattern on the
    // chain's function name could only ever fire via raw stack-frame
    // attribution (dev quirk) and flagged exactly that whitelisted diode.
    // Any real future leak in that chain surfaces as an unaccounted origin
    // in the interval-budget check instead.
    {
      pattern: 'profileBlinking',
      reason:
        'Blink timers self-destroy on detach — running ones here = leak regression',
    },
  ],

  // 12 = registry(18) − 5 on-demand (note-taking, bulk-delete, analytics,
  // badges, feedback-board) − 1 widget-gated (live-streams).
  maxAddons: 12,
  onDemandAddonIds: [
    'note-taking',
    'bulk-delete',
    'analytics',
    'badges',
    'feedback-board',
  ],
  widgetGatedAddonIds: [
    'live-streams', // loads only while the sidebar widget / pin is on stage
  ],

  // Diodes: DMs + notifications (p-tag/etag) always on; nostr-majlis dhikr
  // runs while its widget surfaces exist (3 subscriptions).
  allowedRelaySubscriptionIds: [
    'dm-subscription',
    'notifications-ptag',
    'notifications-etag',
    'nostr-majlis-dhikr-rounds',
    'nostr-majlis-dhikr-commits',
    'nostr-majlis-dhikr-moderation',
  ],
  widgetGatedRelaySubscriptionIds: [],

  maxPrimaryContentChildren: 0,
};

export interface LoadGuardResult {
  ok: boolean;
  violations: string[];
  warnings: string[];
}

function violationsForIntervals(
  snapshot: DevLoadSnapshot,
  e: DevLoadExpectations
): string[] {
  const out: string[] = [];
  // Known (whitelisted) origins win over forbidden patterns: origin
  // attribution can layer caller context into one string (dev stack quirks),
  // and an explicitly justified diode timer must never be flagged by a
  // forbidden pattern matching that layered context.
  const knownPatterns = e.knownIntervalOrigins.map(k => k.pattern);
  const isKnown = (origin: string): boolean =>
    knownPatterns.some(p => origin.includes(p));
  for (const f of e.forbiddenIntervalOrigins) {
    const hits = snapshot.intervals.filter(
      i => i.origin.includes(f.pattern) && !isKnown(i.origin)
    );
    if (hits.length > 0) {
      out.push(
        `forbidden interval "${f.pattern}" running under v2 (${hits.length}×): ${f.reason}`
      );
    }
  }
  for (const k of e.knownIntervalOrigins) {
    const hits = snapshot.intervals.filter(i => i.origin.includes(k.pattern));
    const cap = k.max ?? 0;
    if (hits.length > cap) {
      out.push(
        `interval origin "${k.pattern}" over budget: ${hits.length} active, expected ≤ ${cap} — ${k.reason}`
      );
    }
  }
  for (const t of e.transientIntervalOrigins) {
    const hits = snapshot.intervals.filter(i => i.origin.includes(t.pattern));
    const cap = t.max ?? 0;
    if (hits.length > cap) {
      out.push(
        `transient interval "${t.pattern}" over its cap: ${hits.length} active, expected ≤ ${cap} — ${t.reason}`
      );
    }
  }
  // The budget covers non-transient intervals: boot machinery + diodes +
  // anything unaccounted. Content-scoped/transient origins have their own
  // caps above.
  const transientPatterns = e.transientIntervalOrigins.map(t => t.pattern);
  const budgeted = snapshot.intervals.filter(
    i => !transientPatterns.some(p => i.origin.includes(p))
  );
  if (budgeted.length > e.maxIntervals) {
    const known = e.knownIntervalOrigins.map(k => k.pattern);
    const unknown = budgeted.filter(
      i => !known.some(p => i.origin.includes(p))
    );
    out.push(
      `interval budget exceeded: ${budgeted.length} active (excl. transient), ` +
        `expected ≤ ${e.maxIntervals}${
          unknown.length
            ? ` — new/unaccounted origins (${unknown.length}):\n${unknown
                .map(i => `  · ${i.origin} (age ${i.ageMin} min)`)
                .join('\n')}`
            : ''
        }`
    );
  }
  return out;
}

function violationsForAddons(
  snapshot: DevLoadSnapshot,
  e: DevLoadExpectations
): string[] {
  const out: string[] = [];
  const loaded = snapshot.addons.loaded;
  for (const id of e.onDemandAddonIds) {
    if (loaded.includes(id)) {
      out.push(
        `on-demand addon "${id}" loaded at boot — must load only while its object is open`
      );
    }
  }
  // Widget-gated addons are legitimately on top of the clean-boot budget
  // (each one is +1 while its widget is on stage).
  const widgetGatedLoaded = loaded.filter(id =>
    e.widgetGatedAddonIds.includes(id)
  ).length;
  if (loaded.length > e.maxAddons + widgetGatedLoaded) {
    out.push(
      `addon load budget exceeded: ${loaded.length} loaded, expected ≤ ` +
        `${e.maxAddons + widgetGatedLoaded} ` +
        `(new additions need a boot-load reason or on-demand loading)`
    );
  }
  return out;
}

function checkRelaySubscriptions(
  snapshot: DevLoadSnapshot,
  e: DevLoadExpectations
): { violations: string[]; warnings: string[] } {
  const violations: string[] = [];
  const warnings: string[] = [];
  for (const sub of snapshot.relaySubscriptions) {
    if (e.allowedRelaySubscriptionIds.includes(sub.subId)) continue;
    if (e.widgetGatedRelaySubscriptionIds.includes(sub.subId)) {
      warnings.push(
        `widget-gated relay subscription "${sub.subId}" active — confirm its widget is actually on stage`
      );
    } else {
      violations.push(
        `unknown relay subscription "${sub.subId}" (${sub.kinds}) — declare it in DevLoadExpectations with a reason`
      );
    }
  }
  return { violations, warnings };
}

/**
 * Hidden-state resolution (Phase 6, hidden objects): the base contract is
 * the clean-boot REFERENCE (everything visible). Hidden objects reduce the
 * budgets — hidden = stilllegung (RAM principle), the hidden machinery
 * must NOT be running:
 *
 * - maxAddons derives from the LIVE registry size (registered − on-demand
 *   − widget-gated) minus the hidden always-on addons — provable: their
 *   runtimes are switched off via `<id>:addon-toggle`
 *   (shell/domainShutdown.ts), the loaded count drops by exactly one per
 *   hidden always-on addon. On-demand and widget-gated addons are never
 *   part of the boot baseline.
 * - GroupChatsService.tick cap → 0 when group-chats is hidden (the addon
 *   poller stops with the runtime; a lingering tick = violation).
 * - hiddenAddonIds → evaluateLoadGuard reports a loaded hidden addon as
 *   VIOLATION (not just a lower budget — explicit enforcement).
 *
 * Deliberately NOT reduced: interval caps that are upper bounds on
 * machinery whose per-addon timer share we cannot attribute (AddonLoader
 * runInit ×6 across 12 addons, anonymous module-layer timers) — hidden
 * machinery stopping can only LOWER the count, never break an upper
 * bound; a shrunk-but-wrong cap would create false FAILs. See
 * hidden-objects.md Phase 6 rationale.
 * Pure: the base contract object is never mutated.
 */
/** Live relay-subscription ids a hidden service-backed domain must shed. */
const SERVICE_HIDDEN_SUBS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    messages: ['dm-subscription'],
    notifications: ['notifications-ptag', 'notifications-etag'],
  });

export function resolveExpectationsForHiddenState(
  hiddenIds: readonly string[],
  /** Live registry size (snapshot) — keeps the budget drift-free. */
  registeredAddons?: number
): DevLoadExpectations {
  const e: DevLoadExpectations = {
    ...DEV_LOAD_EXPECTATIONS,
    knownIntervalOrigins: DEV_LOAD_EXPECTATIONS.knownIntervalOrigins.map(k => ({
      ...k,
    })),
    hiddenAddonIds: [],
  };
  let hiddenAlwaysOn = 0;
  for (const id of hiddenIds) {
    const addonId = HIDDEN_ADDON_DOMAINS[id];
    if (!addonId) {
      // Service-backed domain (Phase 4.5): a hidden messages/notifications
      // domain must not hold its live subscriptions — a lingering one is
      // a violation (same philosophy as hiddenAddonIds).
      const subs = SERVICE_HIDDEN_SUBS[id];
      if (subs) {
        e.allowedRelaySubscriptionIds = e.allowedRelaySubscriptionIds.filter(
          s => !subs.includes(s)
        );
      }
      continue; // list-backed / non-addon domain
    }
    e.hiddenAddonIds?.push(addonId);
    const onDemand = e.onDemandAddonIds.includes(addonId);
    const widgetGated = e.widgetGatedAddonIds.includes(addonId);
    if (onDemand || widgetGated) continue;
    hiddenAlwaysOn += 1;
    if (addonId === 'group-chats') {
      const tick = e.knownIntervalOrigins.find(
        k => k.pattern === 'GroupChatsService'
      );
      if (tick) tick.max = 0;
      const client = e.knownIntervalOrigins.find(
        k => k.pattern === 'GroupChatsGroupClient'
      );
      if (client) client.max = 0;
    }
  }
  // The boot budget derives from the LIVE registry (registered − on-demand
  // − widget-gated), minus the hidden always-on addons (their runtimes are
  // switched off — shell/domainShutdown.ts). Deriving from the snapshot
  // makes the budget immune to registry growth; the committed maxAddons is
  // only the fallback when no snapshot size is available.
  const baseline =
    registeredAddons && registeredAddons > 0
      ? registeredAddons -
        e.onDemandAddonIds.length -
        e.widgetGatedAddonIds.length
      : e.maxAddons;
  e.maxAddons = baseline - hiddenAlwaysOn;
  return e;
}

/**
 * Pure evaluation: a live snapshot vs. the committed expectations.
 * `ok === false` only on violations; warnings are advisory.
 */
export function evaluateLoadGuard(
  snapshot: DevLoadSnapshot,
  expectations: DevLoadExpectations
): LoadGuardResult {
  const violations: string[] = [];
  const warnings: string[] = [];

  if (snapshot.focusUiActive !== expectations.requiresFocusUi) {
    return {
      ok: false,
      warnings,
      violations: [
        'Focus UI is not the active interface — run the guard on a clean v2 surface (?focusui=1 or typed trigger)',
      ],
    };
  }

  violations.push(...violationsForIntervals(snapshot, expectations));
  violations.push(...violationsForAddons(snapshot, expectations));
  // Hidden objects (Phase 6): a hidden addon's runtime must be OFF —
  // loaded anyway = the stilllegung did not reach this addon (RAM leak).
  for (const id of expectations.hiddenAddonIds ?? []) {
    if (snapshot.addons.loaded.includes(id)) {
      violations.push(
        `hidden object's addon "${id}" is loaded — hiding must switch the ` +
          'runtime off (shell/domainShutdown.ts); unhide to restore it'
      );
    }
  }

  const subs = checkRelaySubscriptions(snapshot, expectations);
  violations.push(...subs.violations);
  warnings.push(...subs.warnings);
  for (const id of expectations.widgetGatedAddonIds) {
    if (snapshot.addons.loaded.includes(id)) {
      warnings.push(
        `widget-gated addon "${id}" loaded — confirm its widget is actually on stage`
      );
    }
  }

  if (
    snapshot.v1.primaryContentChildren > expectations.maxPrimaryContentChildren
  ) {
    violations.push(
      `v1 primary content mounted while v2 is active: ${snapshot.v1.primaryContentChildren} children ` +
        '(MainLayout did not unmount — double-betrieb)'
    );
  }

  return { ok: violations.length === 0, violations, warnings };
}
