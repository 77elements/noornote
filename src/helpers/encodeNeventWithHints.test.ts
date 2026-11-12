/**
 * Tests for encodeNeventWithHints — NIP-19 nevent encoding with relay + author
 * hints. Regression tests for the URL-reload bug: hint-less nevent URLs made
 * deep-linked notes unfindable on reload ("Note not found") because the URL
 * carried no information about which relays actually hold the event.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getEventRelaysMock = vi.fn<(eventId: string) => string[]>(() => []);

vi.mock('../services/transport/NostrTransport', () => ({
  NostrTransport: {
    getInstance: () => ({ getEventRelays: getEventRelaysMock }),
  },
}));

import { encodeNeventWithHints } from './encodeNeventWithHints';
import { decodeNip19 } from '../services/NostrToolsAdapter';

const HEX_ID = 'a'.repeat(64);
const HEX_AUTHOR = 'b'.repeat(64);

const event = { id: HEX_ID, pubkey: HEX_AUTHOR };

describe('encodeNeventWithHints', () => {
  beforeEach(() => {
    getEventRelaysMock.mockReset();
    getEventRelaysMock.mockImplementation(() => []);
  });

  it('decodes back to the event id and author', () => {
    const nevent = encodeNeventWithHints(event);
    const decoded = decodeNip19(nevent);
    expect(decoded.type).toBe('nevent');
    expect((decoded.data as { id: string }).id).toBe(HEX_ID);
    expect((decoded.data as { author?: string }).author).toBe(HEX_AUTHOR);
  });

  it('embeds seen-on relays as relay hints', () => {
    getEventRelaysMock.mockImplementation(() => [
      'wss://relay-one.example/',
      'wss://relay-two.example/',
    ]);
    const decoded = decodeNip19(encodeNeventWithHints(event));
    expect((decoded.data as { relays?: string[] }).relays).toEqual([
      'wss://relay-one.example/',
      'wss://relay-two.example/',
    ]);
  });

  it('caps relay hints at 3 (URL bloat guard)', () => {
    getEventRelaysMock.mockImplementation(() => [
      'wss://r1.example/',
      'wss://r2.example/',
      'wss://r3.example/',
      'wss://r4.example/',
      'wss://r5.example/',
    ]);
    const decoded = decodeNip19(encodeNeventWithHints(event));
    expect((decoded.data as { relays?: string[] }).relays).toHaveLength(3);
  });

  it('falls back to hint-less encoding when event was seen on no relay', () => {
    const decoded = decodeNip19(encodeNeventWithHints(event));
    expect((decoded.data as { relays?: string[] }).relays).toEqual([]);
    expect((decoded.data as { author?: string }).author).toBe(HEX_AUTHOR);
  });
});
