import { describe, it, expect, beforeEach } from 'vitest';
import {
  temporaryUnmute,
  removeTemporaryUnmute,
  isTemporarilyUnmuted,
  clearTemporaryUnmutes,
} from './temporaryUnmute';

const PK = 'aa'.repeat(32);
const PK2 = 'bb'.repeat(32);

describe('temporary unmute (lists/temporaryUnmute)', () => {
  beforeEach(() => {
    clearTemporaryUnmutes();
  });

  it('REGRESSION: temp-unmute state is readable — FeedOrchestrator consumed it via a non-existent orchestrator property (2026-08-24 bug)', () => {
    expect(isTemporarilyUnmuted(PK)).toBe(false);
    temporaryUnmute(PK);
    expect(isTemporarilyUnmuted(PK)).toBe(true);
    removeTemporaryUnmute(PK);
    expect(isTemporarilyUnmuted(PK)).toBe(false);
  });

  it('tracks pubkeys independently', () => {
    temporaryUnmute(PK);
    expect(isTemporarilyUnmuted(PK)).toBe(true);
    expect(isTemporarilyUnmuted(PK2)).toBe(false);
  });

  it('clearTemporaryUnmutes empties the set', () => {
    temporaryUnmute(PK);
    temporaryUnmute(PK2);
    clearTemporaryUnmutes();
    expect(isTemporarilyUnmuted(PK)).toBe(false);
    expect(isTemporarilyUnmuted(PK2)).toBe(false);
  });

  it('removing an unknown pubkey is a no-op', () => {
    expect(() => removeTemporaryUnmute(PK)).not.toThrow();
  });
});
