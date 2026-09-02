/**
 * Tests for the fanfares-style gated premium note helpers (NIP-108-2.0
 * evolution: kind 1 + `encrypted` (aes-256-gcm) + `price` (SATS) tags).
 *
 * The critical bug this guards against: the public teaser content ends with
 * a self-referential fanfares.io/naddr/<naddr> URL (the CTA) whose naddr
 * encodes THE SAME event — rendering it as a quote reference creates an
 * infinite recursion (the renderer stack-overflow / TV crash source).
 */

import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { nip19 } from 'nostr-tools';
import {
  isGatedNoteEvent,
  getGatedNotePrice,
  stripGatedNoteCta,
  buildFanfaresUrl,
} from './gatedNote';

const AUTHOR =
  'f776bcc12271be79fc71b655f3cbfeb3a8a169f33ee1335fcc0c22829901da4a';
const UUID = 'cdc5bee7-1c36-4780-b85b-34ff63686f72';
const ENCRYPTED_BLOB =
  'KK9t2pUGiQ3IVF3/PVGsaYu9nRxlqDQEg0BajcQvyCnXWBUjiDG+hG78BF2z+SlUbjLnHs7PqE6d1VfReMti+ypWKXmePdxVdkm8mNrrCZ5+H1LmCs+bC6Rukys2K8XwUSd9c9oMHi6PwH+rLna3TeqKN9apwliKTajYUVVDlRdsEbVH7z81hn+ZVuHlhU1Sb3vHJnRGUgMetJgFJQp3TV53KOHfnRBZkaEO/dCPb0ajLygxm2/R8AK+81N2uJGI4pBhuVy2pPPs3dUN/IWraeUN0pK3pQdvHK3nMqDxwPEMtlKtmhVXwjq7w9PxRIzc0MI4yla4eYPNyEmBoYH9P+WkFaZds+Q3w70LxqUo6CzEgzAc81LfZ0sACSHvIyFaUChi7Qp3lDhx044M9Nv0zUW6wHEx9gs9xECfDOKUZ97t+S7hP616cL21XDc=';
const NADDR =
  'naddr1qvzqqqqqqypzpamkhnqjyud70878rdj4709lavag595lx0hpxd0ucrpzs2vsrkj2qyvhwumn8ghj7enpdenxzun9wvhxummnw3erztnrdaksqfrrv33n2cn9v5mj6vtrxvmz6dph8qcz6c3cx43z6ve5venrvvek8qmxvdejqz2fpp';

/** Real premium event shape (fetched live from wss://fanfares.nostr1.com). */
function premiumEvent(overrides?: Partial<NostrEvent>): NostrEvent {
  return {
    id: '0eaa004a6c08',
    pubkey: AUTHOR,
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    tags: [
      ['d', UUID],
      ['encrypted', 'aes-256-gcm', ENCRYPTED_BLOB],
      ['price', '19186', 'SATS'],
      ['referral', '3837'],
      ['zap', AUTHOR, 'wss://fanfares.nostr1.com', '19186'],
    ],
    content: `We just had a miscarriage 😭 My girlfriend started bleeding and we immediately went to the doctor.\nhttps://api.fanfares.live/cdn/teaser.jpg\n⚡Zap 19186 sats to unlock this note on\nhttps://fanfares.io/naddr/${NADDR}`,
    sig: 'c'.repeat(128),
    ...overrides,
  } as NostrEvent;
}

function regularEvent(): NostrEvent {
  return {
    id: '1'.repeat(64),
    pubkey: 'b'.repeat(64),
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    tags: [],
    content: 'just a regular note',
    sig: 'c'.repeat(128),
  } as NostrEvent;
}

describe('isGatedNoteEvent', () => {
  it('detects the fanfares premium shape (encrypted + price tags)', () => {
    expect(isGatedNoteEvent(premiumEvent())).toBe(true);
  });

  it('regular notes are not gated', () => {
    expect(isGatedNoteEvent(regularEvent())).toBe(false);
  });

  it('encrypted tag without a numeric price is not gated', () => {
    const e = premiumEvent({
      tags: [
        ['d', UUID],
        ['encrypted', 'aes-256-gcm', ENCRYPTED_BLOB],
      ],
    } as Partial<NostrEvent>);
    expect(isGatedNoteEvent(e)).toBe(false);
  });

  it('price without the aes-256-gcm encrypted tag is not gated', () => {
    const e = premiumEvent({
      tags: [
        ['d', UUID],
        ['price', '19186', 'SATS'],
      ],
    } as Partial<NostrEvent>);
    expect(isGatedNoteEvent(e)).toBe(false);
  });
});

describe('getGatedNotePrice', () => {
  it('parses the price tag value in sats', () => {
    expect(getGatedNotePrice(premiumEvent())).toBe(19186);
  });

  it('non-gated events → null', () => {
    expect(getGatedNotePrice(regularEvent())).toBeNull();
  });
});

describe('stripGatedNoteCta', () => {
  it('removes the self-referential CTA block (zap line + fanfares URL)', () => {
    const stripped = stripGatedNoteCta(premiumEvent().content);
    expect(stripped).not.toContain('⚡Zap 19186');
    expect(stripped).not.toContain('fanfares.io/naddr');
    expect(stripped).toContain('We just had a miscarriage');
    expect(stripped).toContain('https://api.fanfares.live/cdn/teaser.jpg');
  });

  it('leaves content without a CTA untouched', () => {
    const content = 'plain note without cta';
    expect(stripGatedNoteCta(content)).toBe(content);
  });

  it('handles the CTA with a space after the lightning emoji', () => {
    const content = `Teaser text\n⚡ Zap 500 sats to unlock this note on\nhttps://fanfares.io/naddr/${NADDR}`;
    expect(stripGatedNoteCta(content)).toBe('Teaser text');
  });
});

describe('buildFanfaresUrl', () => {
  it('re-encodes the coordinate as a fanfares.io naddr URL (decode-equivalent)', () => {
    const url = buildFanfaresUrl(premiumEvent());
    expect(url).toMatch(/^https:\/\/fanfares\.io\/naddr\/naddr1/);
    // String equality is not guaranteed (relay TLV hints differ) — the
    // decoded COORDINATE must round-trip.
    const decoded = nip19.decode(
      url!.replace('https://fanfares.io/naddr/', '')
    );
    expect(decoded.type).toBe('naddr');
    expect(decoded.data.kind).toBe(1);
    expect(decoded.data.pubkey).toBe(AUTHOR);
    expect(decoded.data.identifier).toBe(UUID);
  });

  it('events without a d-tag → null', () => {
    expect(buildFanfaresUrl(regularEvent())).toBeNull();
  });
});
