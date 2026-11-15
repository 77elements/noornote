import { describe, expect, it } from 'vitest';
import {
  MAX_EMPTY_LOAD_STREAK,
  shouldLatchTerminalAfterEmptyStreak,
} from './infiniteScrollRefill';

describe('shouldLatchTerminalAfterEmptyStreak', () => {
  it('does not latch below the streak cap', () => {
    expect(shouldLatchTerminalAfterEmptyStreak(0)).toBe(false);
    expect(shouldLatchTerminalAfterEmptyStreak(1)).toBe(false);
    expect(shouldLatchTerminalAfterEmptyStreak(MAX_EMPTY_LOAD_STREAK - 1)).toBe(
      false
    );
  });

  it('latches at the streak cap and beyond', () => {
    expect(shouldLatchTerminalAfterEmptyStreak(MAX_EMPTY_LOAD_STREAK)).toBe(
      true
    );
    expect(shouldLatchTerminalAfterEmptyStreak(MAX_EMPTY_LOAD_STREAK + 1)).toBe(
      true
    );
  });
});
