// @vitest-environment jsdom
/**
 * Tests for RelayRateLimitGuard — the relay-friendliness backoff layer
 * (nos.lol-style per-IP REQ caps + auto-bans; NDK 3.0.3 reconnects >60s-old
 * sockets with 0ms delay, so the app needs its own storm breaker).
 *
 * Focus: backoff lifecycle (soft notice vs. storm disconnect + scheduled
 * reconnect), exponential escalation, relay-set filtering, and the REQ
 * accounting thresholds.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { disconnectMock, reconnectMock, warnMock } = vi.hoisted(() => ({
  disconnectMock: vi.fn(),
  reconnectMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('../DiagnosticLogger', () => ({
  diagLog: vi.fn(),
}));

vi.mock('../SystemLogger', () => ({
  SystemLogger: {
    getInstance: () => ({
      info: vi.fn(),
      success: vi.fn(),
      warn: warnMock,
      error: vi.fn(),
    }),
  },
}));

import {
  RelayRateLimitGuard,
  RATE_LIMIT_RE,
  BACKOFF_STEPS_MS,
  STORM_THRESHOLD,
  STORM_WINDOW_MS,
} from './RelayRateLimitGuard';

const RELAY = 'wss://relay.test';

describe('RelayRateLimitGuard', () => {
  let guard: RelayRateLimitGuard;

  beforeEach(() => {
    vi.useFakeTimers();
    guard = RelayRateLimitGuard.getInstance();
    guard.destroy();
    guard.setTransportHooks(reconnectMock, disconnectMock);
    disconnectMock.mockClear();
    reconnectMock.mockClear();
    warnMock.mockClear();
  });

  afterEach(() => {
    guard.destroy();
    vi.useRealTimers();
  });

  describe('rate-limit signal (soft backoff)', () => {
    it('backs off a relay on a throttle NOTICE without disconnecting it', () => {
      guard.observeRateLimitSignal(RELAY, 'notice', 'rate limit exceeded');

      expect(guard.isBackedOff(RELAY)).toBe(true);
      expect(guard.backoffRemainingMs(RELAY)).toBeGreaterThan(0);
      expect(disconnectMock).not.toHaveBeenCalled();
    });

    it('filters backed-off relays out of relay sets and re-enables after expiry', () => {
      guard.observeRateLimitSignal(RELAY, 'notice', 'slow down');
      expect(guard.filter([RELAY, 'wss://other.test'])).toEqual([
        'wss://other.test',
      ]);

      // Advance past the first backoff step
      vi.advanceTimersByTime(BACKOFF_STEPS_MS[0]! + 1);

      expect(guard.isBackedOff(RELAY)).toBe(false);
      expect(guard.filter([RELAY])).toEqual([RELAY]);
      // Soft backoff: socket stayed open, so the reconnector is still called
      // (harmless no-op for a connected relay) — documented behavior.
      expect(reconnectMock).toHaveBeenCalledWith(RELAY);
    });

    it('escalates exponentially when signals repeat during backoff', () => {
      guard.observeRateLimitSignal(RELAY, 'notice', 'rate limited');
      const first = guard.backoffRemainingMs(RELAY);
      expect(first).toBe(BACKOFF_STEPS_MS[0]);

      // Second signal while still backed off → step up
      vi.advanceTimersByTime(1000);
      guard.observeRateLimitSignal(RELAY, 'closed', 'CLOSED: too many REQs');
      const second = guard.backoffRemainingMs(RELAY);
      // Step 2 duration minus the 1s already elapsed
      expect(second).toBeGreaterThan(BACKOFF_STEPS_MS[0]!);
      expect(second).toBeLessThanOrEqual(BACKOFF_STEPS_MS[1]!);
    });
  });

  describe('reconnect storm', () => {
    it('disconnects and backs off a relay after the storm threshold', () => {
      for (let i = 0; i < STORM_THRESHOLD - 1; i++) {
        guard.observeConnect(RELAY);
      }
      expect(guard.isBackedOff(RELAY)).toBe(false);
      expect(disconnectMock).not.toHaveBeenCalled();

      // The connect that crosses the threshold trips the storm breaker
      guard.observeConnect(RELAY);
      expect(guard.isBackedOff(RELAY)).toBe(true);
      expect(disconnectMock).toHaveBeenCalledWith(RELAY);
    });

    it('connects outside the storm window do not accumulate', () => {
      for (let i = 0; i < STORM_THRESHOLD; i++) {
        guard.observeConnect(RELAY);
        vi.advanceTimersByTime(STORM_WINDOW_MS / 2);
      }
      expect(guard.isBackedOff(RELAY)).toBe(false);
      expect(disconnectMock).not.toHaveBeenCalled();
    });

    it('reconnects the relay when the storm backoff expires', () => {
      for (let i = 0; i < STORM_THRESHOLD; i++) guard.observeConnect(RELAY);
      expect(disconnectMock).toHaveBeenCalled();

      vi.advanceTimersByTime(BACKOFF_STEPS_MS[0]! + 1);
      expect(guard.isBackedOff(RELAY)).toBe(false);
      expect(reconnectMock).toHaveBeenCalledWith(RELAY);
    });
  });

  describe('REQ accounting', () => {
    it('counts REQs per relay in a rolling window', () => {
      guard.countRequest([RELAY]);
      guard.countRequest([RELAY, 'wss://other.test']);
      expect(guard.reqsLastMinute(RELAY)).toBe(2);
      expect(guard.reqsLastMinute('wss://other.test')).toBe(1);

      vi.advanceTimersByTime(60_001);
      expect(guard.reqsLastMinute(RELAY)).toBe(0);
    });

    it('fires the NIP-11 discovery fetch on demand, not on every contact', () => {
      const fetchMock = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ limitation: { max_reqs: 1200 } }),
        })
      );
      vi.stubGlobal('fetch', fetchMock);

      // Normal traffic: NO extra outbound call
      guard.countRequest([RELAY]);
      guard.countRequest([RELAY]);
      expect(fetchMock).not.toHaveBeenCalled();

      // Rate-limit signal → learn the relay's budget
      guard.observeRateLimitSignal(RELAY, 'notice', 'rate limited');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![0]).toBe('https://relay.test');

      // Only once per relay
      guard.observeRateLimitSignal(RELAY, 'closed', 'too many');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      vi.unstubAllGlobals();
    });
  });

  describe('throttle phrase detection', () => {
    it('matches the relay NOTICE/CLOSED phrasings that matter', () => {
      expect(RATE_LIMIT_RE.test('rate limit exceeded')).toBe(true);
      expect(RATE_LIMIT_RE.test('CLOSED: too many subscriptions')).toBe(true);
      expect(RATE_LIMIT_RE.test('maximum REQs reached')).toBe(true);
      expect(RATE_LIMIT_RE.test('temporarily banned')).toBe(true);
      expect(RATE_LIMIT_RE.test('welcome to nos.lol')).toBe(false);
      expect(RATE_LIMIT_RE.test('event stored')).toBe(false);
    });
  });
});
