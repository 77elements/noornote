import { describe, it, expect } from 'vitest';
import { decodeEventReference } from './nip19';
import { encodeNevent, noteEncode } from '../services/NostrToolsAdapter';

/**
 * Regression tests for the relay-hint fetch path (SNV "Note not found" bug).
 *
 * A nevent carries relay hints — the publisher's statement of where the event
 * is retrievable. SNV must try those hint relays BEFORE falling back to the
 * user's own read relays. Previously hints were dropped during decoding and
 * only the user's own relays were queried, so shared links (e.g. from other
 * clients) 404'd with "Note not found" after a reload whenever the event had
 * fallen off the user's own relays.
 */

const EVENT_ID =
  '0ac34bad35eaf244df37373c6ff966e36f061e538f85a1811304df2e89b9bc29';
const HINT_RELAYS = [
  'wss://noornode.nostr1.com/',
  'wss://bitcoinmajlis.nostr1.com/',
];

describe('decodeEventReference (SNV relay hints)', () => {
  it('extracts relay hints from a nevent and preserves the hex id', () => {
    const nevent = encodeNevent(EVENT_ID, HINT_RELAYS);
    const decoded = decodeEventReference(nevent);
    expect(decoded.id).toBe(EVENT_ID);
    expect(decoded.relays).toEqual(HINT_RELAYS);
  });

  it('returns no hints for a nevent without relay payload', () => {
    const nevent = encodeNevent(EVENT_ID, []);
    const decoded = decodeEventReference(nevent);
    expect(decoded.id).toBe(EVENT_ID);
    expect(decoded.relays).toEqual([]);
  });

  it('decodes note1 references (no hints by design)', () => {
    const decoded = decodeEventReference(noteEncode(EVENT_ID));
    expect(decoded.id).toBe(EVENT_ID);
    expect(decoded.relays).toEqual([]);
  });

  it('passes through raw hex ids unchanged', () => {
    const decoded = decodeEventReference(EVENT_ID);
    expect(decoded.id).toBe(EVENT_ID);
    expect(decoded.relays).toEqual([]);
  });

  it('falls back to the raw string on corrupt nevent input', () => {
    const corrupt = 'nevent1qqnotarealbech32payload';
    const decoded = decodeEventReference(corrupt);
    expect(decoded.id).toBe(corrupt);
    expect(decoded.relays).toEqual([]);
  });

  it('round-trips the exact nevent that other clients share', () => {
    // Jumble-style share link: hint relays present. Encoding the hex id with
    // the same hints must decode back to the same id + hints — this is the
    // payload the SNV fetch now consumes (hint-first).
    const author =
      'f527cf970cab8b9c9e0504f0a2f6f6bd42e1f7f1f4a9c8b3d2e1f0a9b8c7d6e5';
    const nevent = encodeNevent(EVENT_ID, HINT_RELAYS, author);
    const decoded = decodeEventReference(nevent);
    expect(decoded.id).toBe(EVENT_ID);
    expect(decoded.relays).toEqual(HINT_RELAYS);
  });
});
