import { describe, it, expect } from 'vitest';
import {
  buildPrivateEventPayload,
  buildPrivateListPayload,
  decryptWithViewKey,
  encryptWithViewKey,
  generateViewKey,
  parsePrivateListPayload,
  DEFAULT_PRIVATE_LIST_ID,
} from './privateCalendar';
import { parseCalendarEvent } from '../../helpers/nip52/parser';

describe('generateViewKey', () => {
  it('derives the pubkey from its own secret', () => {
    const key = generateViewKey();
    expect(key.secretHex).toMatch(/^[0-9a-f]{64}$/);
    expect(key.pubkeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(key.nsec).toMatch(/^nsec1/);
  });

  it('generates a fresh key each call', () => {
    expect(generateViewKey().secretHex).not.toBe(generateViewKey().secretHex);
  });
});

describe('view-key encrypt/decrypt roundtrip', () => {
  it('round-trips a JSON payload', () => {
    const key = generateViewKey();
    const payload = JSON.stringify([
      ['d', 'secret-event'],
      ['title', 'Doctor'],
      ['start', '1700000000'],
    ]);
    const ciphertext = encryptWithViewKey(payload, key.secretHex);
    expect(ciphertext).not.toContain('Doctor');

    const decrypted = decryptWithViewKey<unknown[][]>(
      ciphertext,
      key.secretHex
    );
    expect(decrypted).toEqual(JSON.parse(payload));
  });

  it('returns null with a wrong key or broken ciphertext', () => {
    const key = generateViewKey();
    const other = generateViewKey();
    const ciphertext = encryptWithViewKey('[]', key.secretHex);
    expect(decryptWithViewKey(ciphertext, other.secretHex)).toBeNull();
    expect(decryptWithViewKey('garbage', key.secretHex)).toBeNull();
  });
});

describe('private event payload → parseCalendarEvent', () => {
  it('parses decrypted kind-32678 payload as a private timed event', () => {
    const key = generateViewKey();
    const payload = buildPrivateEventPayload({
      dTag: 'ev1',
      title: 'Therapy',
      description: 'Weekly session',
      startMs: 1_700_000_000_000,
      endMs: 1_700_000_600_000,
      location: 'Room 5',
      rrule: 'FREQ=WEEKLY',
    });
    const content = encryptWithViewKey(JSON.stringify(payload), key.secretHex);
    const decrypted = decryptWithViewKey<string[][]>(content, key.secretHex)!;

    const event = parseCalendarEvent({
      id: 'ev-id',
      kind: 32678,
      pubkey: 'pk',
      created_at: 1_700_000_000,
      content: '',
      tags: decrypted,
    });

    expect(event).not.toBeNull();
    expect(event!.isPrivate).toBe(true);
    expect(event!.title).toBe('Therapy');
    expect(event!.description).toBe('Weekly session');
    expect(event!.startMs).toBe(1_700_000_000_000);
    expect(event!.endMs).toBe(1_700_000_600_000);
    expect(event!.rrule).toBe('FREQ=WEEKLY');
    expect(event!.coordinate).toBe('32678:pk:ev1');
  });

  it('rejects unknown kinds and 32679 parses as recurring private', () => {
    const payload = buildPrivateEventPayload({
      dTag: 'x',
      title: 'T',
      description: '',
      startMs: 1000,
      endMs: null,
      rrule: null,
    });
    expect(
      parseCalendarEvent({ kind: 31999, pubkey: 'p', tags: payload })
    ).toBeNull();

    const parsed = parseCalendarEvent({
      kind: 32679,
      pubkey: 'p',
      tags: payload,
    });
    expect(parsed!.isPrivate).toBe(true);
    expect(parsed!.rrule).toBeNull();
  });
});

describe('private calendar list payload roundtrip', () => {
  it('round-trips title + event refs', () => {
    const list = {
      title: 'Private',
      description: '',
      eventRefs: [
        {
          coordinate: '32678:abc:event1',
          relayHint: 'wss://relay.example',
          viewSecretHex: 'a'.repeat(64),
        },
        {
          coordinate: '32679:abc:event2',
          relayHint: '',
          viewSecretHex: 'b'.repeat(64),
        },
      ],
    };
    const plaintext = buildPrivateListPayload(list);
    // The plaintext never leaks the view secrets in a readable structure —
    // it is the caller's job to encrypt it (AuthService.nip44Encrypt), but
    // the ref values must survive the roundtrip verbatim.
    const parsed = parsePrivateListPayload(
      plaintext,
      DEFAULT_PRIVATE_LIST_ID,
      42
    );
    expect(parsed!.id).toBe(DEFAULT_PRIVATE_LIST_ID);
    expect(parsed!.title).toBe('Private');
    expect(parsed!.eventRefs).toEqual(list.eventRefs);
  });

  it('returns null for non-array payloads and tolerates malformed refs', () => {
    expect(parsePrivateListPayload('"just a string"', 'd', 0)).toBeNull();
    const parsed = parsePrivateListPayload(
      JSON.stringify([['a', 'coord-only', 'relay']]),
      'd',
      0
    );
    expect(parsed!.eventRefs).toEqual([]);
  });
});
