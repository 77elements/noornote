// @vitest-environment jsdom
/**
 * Device tier detection — the render-cost switch for weak phones.
 *
 * Regression guard for the progressive timeline paint: low-end devices
 * (≤ 4 cores or ≤ 4 GB reported) must get smaller first-paint/batch sizes,
 * unknown browsers must stay on the high tier (no behavior change), and the
 * tier is memoized per session.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getDeviceTier,
  getFirstPaintCount,
  getRenderBatchSize,
  resetDeviceTierCache,
} from './deviceTier';

type NavWithHints = Navigator & { deviceMemory?: number };

function setHints(
  cores: number | undefined,
  memoryGb: number | undefined
): void {
  const nav = navigator as NavWithHints;
  if (cores === undefined) {
    delete (nav as { hardwareConcurrency?: number }).hardwareConcurrency;
  } else {
    Object.defineProperty(nav, 'hardwareConcurrency', {
      value: cores,
      configurable: true,
    });
  }
  if (memoryGb === undefined) {
    delete nav.deviceMemory;
  } else {
    Object.defineProperty(nav, 'deviceMemory', {
      value: memoryGb,
      configurable: true,
    });
  }
}

describe('deviceTier', () => {
  beforeEach(() => {
    resetDeviceTierCache();
    setHints(undefined, undefined);
  });

  afterEach(() => {
    resetDeviceTierCache();
    setHints(undefined, undefined);
  });

  it('high tier when no hardware hints exist (unknown browser)', () => {
    expect(getDeviceTier()).toBe('high');
    expect(getFirstPaintCount()).toBe(12);
    expect(getRenderBatchSize()).toBe(12);
  });

  it('high tier when only hardwareConcurrency is reported (typical desktop)', () => {
    setHints(16, undefined);
    expect(getDeviceTier()).toBe('high');
  });

  it('low tier on few cores', () => {
    setHints(4, undefined);
    expect(getDeviceTier()).toBe('low');
  });

  it('low tier on low reported memory', () => {
    setHints(undefined, 2);
    expect(getDeviceTier()).toBe('low');
    expect(getFirstPaintCount()).toBe(8);
    expect(getRenderBatchSize()).toBe(6);
  });

  it('high tier on strong hardware', () => {
    setHints(8, 8);
    expect(getDeviceTier()).toBe('high');
  });

  it('tier is memoized per session', () => {
    setHints(2, undefined);
    expect(getDeviceTier()).toBe('low');
    // Hardware doesn't change mid-session — a later different report is ignored.
    setHints(16, 8);
    expect(getDeviceTier()).toBe('low');
  });
});
