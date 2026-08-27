import { describe, it, expect } from 'vitest';
import { capRelayHints } from './capRelayHints';

describe('capRelayHints', () => {
  it('returns primary relays first, padded from fallback up to the cap', () => {
    expect(
      capRelayHints(['wss://seen.one'], ['wss://w1', 'wss://w2', 'wss://w3'])
    ).toEqual(['wss://seen.one', 'wss://w1', 'wss://w2']);
  });

  it('falls back to write relays when no seen-on relays are known', () => {
    expect(capRelayHints([], ['wss://w1', 'wss://w2'])).toEqual([
      'wss://w1',
      'wss://w2',
    ]);
  });

  it('dedupes relays present in both lists', () => {
    expect(
      capRelayHints(['wss://dup', 'wss://a'], ['wss://dup', 'wss://b'])
    ).toEqual(['wss://dup', 'wss://a', 'wss://b']);
  });

  it('caps at 3 hints even with many seen-on relays', () => {
    expect(capRelayHints(['wss://a', 'wss://b', 'wss://c', 'wss://d'])).toEqual(
      ['wss://a', 'wss://b', 'wss://c']
    );
  });

  it('skips empty entries and returns [] when nothing is known', () => {
    expect(capRelayHints(['', undefined as unknown as string], [])).toEqual([]);
    expect(capRelayHints([], [])).toEqual([]);
  });

  it('respects a custom max', () => {
    expect(capRelayHints(['wss://a', 'wss://b'], [], 1)).toEqual(['wss://a']);
  });
});
