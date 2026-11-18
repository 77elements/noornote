/**
 * Tests for the dev load guard evaluation (pure logic — no timers involved).
 * The guard compares a DevLoadSnapshot against the committed expectations;
 * these tests cover every check branch with synthetic snapshots.
 */
import { describe, it, expect } from 'vitest';
import {
  DEV_LOAD_EXPECTATIONS,
  evaluateLoadGuard,
  resolveExpectationsForHiddenState,
  type DevLoadExpectations,
} from './DevLoadExpectations';
import type { DevLoadSnapshot } from './DevLoadMonitor';

function baseSnapshot(): DevLoadSnapshot {
  return {
    focusUi: true,
    focusUiActive: true,
    relaySubscriptions: [],
    intervals: [],
    timeoutsActive: 0,
    modules: { loaded: [], registered: 13 },
    addons: { loaded: [], registered: 18 },
    v1: { mainLayoutMounted: false, primaryContentChildren: 0 },
    sections: {},
  };
}

/** Full clean-boot baseline: everything at the committed budget. */
function baselineSnapshot(): DevLoadSnapshot {
  const s = baseSnapshot();
  s.intervals = [
    { id: 1, origin: 'at init (main.ts:117:13)', ageMin: 0 },
    { id: 2, origin: 'at async init (main.ts:117:3)', ageMin: 0 },
    ...Array.from({ length: 6 }, (_, i) => ({
      id: 3 + i,
      origin: `at AddonLoader.runInit (addons/AddonLoader.ts:337:1${i})`,
      ageMin: 0,
    })),
    {
      id: 20,
      origin: 'at NostrTransport.doConnect (NostrTransport.ts:357)',
      ageMin: 0,
    },
    {
      id: 40,
      origin:
        'at BookmarkReadStateService.start (BookmarkReadStateService.ts:101)',
      ageMin: 0,
    },
    ...Array.from({ length: 3 }, (_, i) => ({
      id: 21 + i,
      origin: `at async PostLoginService.handleLogin (PostLoginService.ts:7${i})`,
      ageMin: 0,
    })),
    ...Array.from({ length: 8 }, (_, i) => ({
      id: 30 + i,
      origin: `at anonymous ${i}`,
      ageMin: 0,
    })),
  ];
  s.relaySubscriptions = [
    { subId: 'dm-subscription', relays: [], kinds: 'k:4' },
    { subId: 'notifications-ptag', relays: [], kinds: 'k:1 lim:50' },
    { subId: 'notifications-etag', relays: [], kinds: 'k:1 lim:50' },
    { subId: 'nostr-majlis-dhikr-rounds', relays: [], kinds: 'k:41981' },
    { subId: 'nostr-majlis-dhikr-commits', relays: [], kinds: 'k:41981' },
    { subId: 'nostr-majlis-dhikr-moderation', relays: [], kinds: 'k:41981' },
  ];
  s.addons.loaded = Array.from({ length: 12 }, (_, i) => `always-on-${i}`);
  return s;
}

function tightExpectations(): DevLoadExpectations {
  return {
    requiresFocusUi: true,
    maxIntervals: 21,
    knownIntervalOrigins: [
      { pattern: 'main.ts', reason: 'boot', max: 2 },
      { pattern: 'AddonLoader', reason: 'addons', max: 6 },
      { pattern: 'NostrTransport.doConnect', reason: 'prune', max: 1 },
      { pattern: 'PostLoginService', reason: 'login sync', max: 3 },
      { pattern: 'BookmarkReadStateService', reason: 'bookmark diode', max: 1 },
    ],
    transientIntervalOrigins: [
      { pattern: 'ContentProcessor', reason: 'content-scoped timers', max: 5 },
      {
        pattern: 'NoteStructureBuilder',
        reason: 'media fallback timers',
        max: 4,
      },
      { pattern: 'fetchCore', reason: 'ndk fetch timeouts', max: 8 },
    ],
    forbiddenIntervalOrigins: [
      { pattern: 'AutoSyncService', reason: 'v1 machinery' },
    ],
    maxAddons: 12,
    onDemandAddonIds: ['bulk-delete'],
    widgetGatedAddonIds: ['live-streams'],
    allowedRelaySubscriptionIds: [
      'dm-subscription',
      'notifications-ptag',
      'notifications-etag',
      'nostr-majlis-dhikr-rounds',
      'nostr-majlis-dhikr-commits',
      'nostr-majlis-dhikr-moderation',
    ],
    widgetGatedRelaySubscriptionIds: ['dhikr-widget'],
    maxPrimaryContentChildren: 0,
  };
}

describe('evaluateLoadGuard', () => {
  it('passes the clean baseline snapshot (no violations, no warnings)', () => {
    const result = evaluateLoadGuard(baselineSnapshot(), tightExpectations());
    expect(result.ok, `violations: ${result.violations.join('; ')}`).toBe(true);
    expect(
      result.violations,
      `violations: ${result.violations.join('; ')}`
    ).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('reports the applied-interface mismatch instead of false positives', () => {
    const s = baselineSnapshot();
    s.focusUiActive = false;
    const result = evaluateLoadGuard(s, tightExpectations());
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toContain(
      'Focus UI is not the active interface'
    );
    // No further evaluation — the v1 baselines do not apply here.
    expect(result.violations).toHaveLength(1);
  });

  it('fails when the interval budget is exceeded and lists unknown origins', () => {
    const s = baselineSnapshot();
    s.intervals.push({
      id: 99,
      origin: 'at SomethingNew.start (SomethingNew.ts:42)',
      ageMin: 0,
    });
    const result = evaluateLoadGuard(s, tightExpectations());
    expect(result.ok).toBe(false);
    expect(
      result.violations.some(v => v.includes('interval budget exceeded'))
    ).toBe(true);
    expect(result.violations.some(v => v.includes('SomethingNew.ts'))).toBe(
      true
    );
  });

  it('fails when a known interval origin exceeds its pattern cap', () => {
    const s = baselineSnapshot();
    s.intervals.push({
      id: 100,
      origin: 'at PostLoginService.handleLogin (PostLoginService.ts:80)',
      ageMin: 0,
    });
    const result = evaluateLoadGuard(s, tightExpectations());
    expect(
      result.violations.some(
        v => v.includes('PostLoginService') && v.includes('over budget: 4')
      )
    ).toBe(true);
  });

  it('fails when a forbidden v1 origin schedules an interval under v2', () => {
    const s = baselineSnapshot();
    s.intervals.push({
      id: 101,
      origin: 'at AutoSyncService.syncAll (AutoSyncService.ts:66)',
      ageMin: 0,
    });
    const result = evaluateLoadGuard(s, tightExpectations());
    expect(
      result.violations.some(
        v => v.includes('forbidden interval') && v.includes('AutoSyncService')
      )
    ).toBe(true);
  });

  it('excludes transient content-scoped origins from the interval budget', () => {
    const s = baselineSnapshot();
    // Content-scoped timers that appear with a restored profile route —
    // must NOT trip the boot budget, only their own caps.
    s.intervals.push(
      { id: 110, origin: 'at services/ContentProcessor.ts:201:102', ageMin: 0 },
      { id: 111, origin: 'at services/ContentProcessor.ts:201:102', ageMin: 1 },
      {
        id: 112,
        origin: 'at NoteStructureBuilder.build (x.ts:122)',
        ageMin: 0,
      },
      { id: 113, origin: 'at NostrTransport.fetchCore (y.ts:638)', ageMin: 0 }
    );
    const result = evaluateLoadGuard(s, tightExpectations());
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('fails when a transient origin exceeds its own cap', () => {
    const s = baselineSnapshot();
    const e = tightExpectations();
    e.transientIntervalOrigins = [
      { pattern: 'ContentProcessor', reason: 'content-scoped timers', max: 1 },
    ];
    s.intervals.push(
      { id: 120, origin: 'at services/ContentProcessor.ts:201:102', ageMin: 0 },
      { id: 121, origin: 'at services/ContentProcessor.ts:201:102', ageMin: 0 }
    );
    const result = evaluateLoadGuard(s, e);
    expect(
      result.violations.some(
        v =>
          v.includes('transient interval "ContentProcessor"') &&
          v.includes('cap: 2')
      )
    ).toBe(true);
  });

  it('fails when an on-demand addon is loaded at boot', () => {
    const s = baselineSnapshot();
    s.addons.loaded.push('bulk-delete');
    const result = evaluateLoadGuard(s, tightExpectations());
    expect(
      result.violations.some(v =>
        v.includes('on-demand addon "bulk-delete" loaded at boot')
      )
    ).toBe(true);
  });

  it('fails when the addon budget is exceeded without a boot reason', () => {
    const s = baselineSnapshot();
    s.addons.loaded.push('extra-addon');
    const result = evaluateLoadGuard(s, tightExpectations());
    expect(
      result.violations.some(v => v.includes('addon load budget exceeded: 13'))
    ).toBe(true);
  });

  it('fails on an unknown relay subscription with a declare-here hint', () => {
    const s = baselineSnapshot();
    s.relaySubscriptions.push({
      subId: 'surprise-sub',
      relays: [],
      kinds: 'k:1',
    });
    const result = evaluateLoadGuard(s, tightExpectations());
    expect(
      result.violations.some(
        v =>
          v.includes('unknown relay subscription "surprise-sub"') &&
          v.includes('DevLoadExpectations')
      )
    ).toBe(true);
  });

  it('warns (not fails) on widget-gated subscriptions and addons', () => {
    const s = baselineSnapshot();
    s.relaySubscriptions.push({
      subId: 'dhikr-widget',
      relays: [],
      kinds: 'k:1',
    });
    s.addons.loaded.push('live-streams');
    const result = evaluateLoadGuard(s, tightExpectations());
    expect(result.ok).toBe(true);
    expect(
      result.warnings.some(w => w.includes('widget-gated relay subscription'))
    ).toBe(true);
    expect(
      result.warnings.some(w => w.includes('widget-gated addon "live-streams"'))
    ).toBe(true);
  });

  it('fails when v1 primary content mounts children while v2 is active', () => {
    const s = baselineSnapshot();
    s.v1.primaryContentChildren = 2;
    const result = evaluateLoadGuard(s, tightExpectations());
    expect(
      result.violations.some(v => v.includes('v1 primary content mounted'))
    ).toBe(true);
  });
});

describe('resolveExpectationsForHiddenState (Phase 6, hidden objects)', () => {
  it('reduces the budget per hidden always-on addon (interval caps stay upper bounds)', () => {
    const base = DEV_LOAD_EXPECTATIONS;
    const resolved = resolveExpectationsForHiddenState(['group-chats']);
    expect(resolved).not.toBe(base); // pure — base untouched
    expect(resolved.maxAddons).toBe(base.maxAddons - 1);
    expect(resolved.hiddenAddonIds).toEqual(['group-chats']);
    // The AddonLoader runInit cap is NOT per-addon attributable (6 timers
    // across 12 addons) — it stays an honest upper bound.
    expect(
      resolved.knownIntervalOrigins.find(k => k.pattern === 'AddonLoader')?.max
    ).toBe(
      base.knownIntervalOrigins.find(k => k.pattern === 'AddonLoader')?.max
    );
  });

  it('derives the budget from the live registry size (drift-free)', () => {
    const resolved = resolveExpectationsForHiddenState(['group-chats'], 19);
    // 19 registered − 5 on-demand − 1 widget-gated = 13 baseline, −1 hidden
    expect(resolved.maxAddons).toBe(12);
  });

  it('keeps the boot budget for hidden on-demand addons (never in the baseline)', () => {
    const base = DEV_LOAD_EXPECTATIONS;
    const resolved = resolveExpectationsForHiddenState(['bulk-delete']);
    expect(resolved.maxAddons).toBe(base.maxAddons);
    expect(resolved.hiddenAddonIds).toEqual(['bulk-delete']);
  });

  it('zeroes the group-chats tick cap and ignores list-backed domains', () => {
    const resolved = resolveExpectationsForHiddenState([
      'group-chats',
      'bookmarks',
      'muted',
    ]);
    expect(
      resolved.transientIntervalOrigins.find(
        t => t.pattern === 'GroupChatsService.tick'
      )?.max
    ).toBe(0);
    expect(resolved.hiddenAddonIds).toEqual(['group-chats']);
  });

  it('fails the guard when a hidden addon is loaded anyway', () => {
    const s = baselineSnapshot();
    s.addons.loaded.push('group-chats');
    const e = resolveExpectationsForHiddenState(['group-chats']);
    const result = evaluateLoadGuard(s, e);
    expect(result.ok).toBe(false);
    expect(
      result.violations.some(v =>
        v.includes('hidden object\'s addon "group-chats"')
      )
    ).toBe(true);
  });

  it('removes the live subs of hidden service-backed domains (Phase 4.5)', () => {
    const base = DEV_LOAD_EXPECTATIONS;
    const messages = resolveExpectationsForHiddenState(['messages']);
    expect(messages.allowedRelaySubscriptionIds).not.toContain(
      'dm-subscription'
    );
    expect(base.allowedRelaySubscriptionIds).toContain('dm-subscription'); // pure
    const notifications = resolveExpectationsForHiddenState(['notifications']);
    expect(notifications.allowedRelaySubscriptionIds).not.toContain(
      'notifications-ptag'
    );
    expect(notifications.allowedRelaySubscriptionIds).not.toContain(
      'notifications-etag'
    );
  });
});
