/**
 * Read-relay cap tests (browser WebSocket budget, Phase 1 of the relay
 * connection-limit work).
 *
 * The cap trims a relay list built user-relays-first, aggregators-last, so
 * a plain slice keeps what the user chose explicitly and drops aggregator
 * redundancy first. Electron passes cap = null (uncapped).
 */

import { describe, expect, it } from 'vitest';
import { capReadRelays, BROWSER_MAX_READ_RELAYS } from './relayReadCap';

const range = (n: number, prefix = 'wss://relay') =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}.example.com`);

describe('capReadRelays', () => {
  it('passes the list through when uncapped (Electron, cap = null)', () => {
    const urls = range(50);
    expect(capReadRelays(urls, null)).toBe(urls);
  });

  it('passes the list through when under the cap', () => {
    const urls = range(10);
    expect(capReadRelays(urls, 32)).toBe(urls);
  });

  it('trims to the cap, keeping the head of the list', () => {
    const urls = range(40);
    expect(capReadRelays(urls, BROWSER_MAX_READ_RELAYS)).toEqual(range(32));
  });

  it('keeps user relays before aggregators (list order is significant)', () => {
    const urls = ['wss://user-a.example', 'wss://agg-1', 'wss://agg-2'];
    expect(capReadRelays(urls, 1)).toEqual(['wss://user-a.example']);
  });

  it('does not mutate the input array', () => {
    const urls = range(40);
    capReadRelays(urls, 32);
    expect(urls).toHaveLength(40);
  });
});
