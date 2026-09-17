/**
 * NIP-52E private calendar events (Form*-style) — crypto + payload helpers.
 *
 * - Kind 32678/32679: the event data rides as a JSON tag-array encrypted with
 *   NIP-44 using a one-time VIEW KEY (self-ECDH of the view keypair — pure
 *   local crypto, no signer involvement). Only `["d", …]` is visible.
 * - Kind 32123 (private calendar list): NIP-44 self-encrypted to the user's
 *   own keypair via AuthService.nip44Encrypt (signer-agnostic: works with
 *   NIP-07, NIP-46 and local keys). Each event ref carries the view key.
 *
 * Reference: formstr-hq/nostr-calendar src/nostr/events.ts + calendars.ts.
 */

import {
  bytesToHex,
  generateSecretKey,
  nip44ConversationKey,
  nip44DecryptWithKey,
  getPublicKeyFromPrivate,
  encodeNsec,
  nip44Encrypt,
} from '../../services/NostrToolsAdapter';
import {
  PRIVATE_EVENT_KIND,
  PRIVATE_RECURRING_EVENT_KIND,
} from '../../helpers/nip52/parser';

export interface PrivateViewKey {
  /** Hex secret — stored only inside the (encrypted) list ref + cache. */
  secretHex: string;
  pubkeyHex: string;
  nsec: string;
}

export function generateViewKey(): PrivateViewKey {
  const secret = generateSecretKey();
  const secretHex = bytesToHex(secret);
  return {
    secretHex,
    pubkeyHex: getPublicKeyFromPrivate(secretHex),
    nsec: encodeNsec(secretHex),
  };
}

/** NIP-44 encrypt with a view-key secret (self-ECDH, fully local). */
export function encryptWithViewKey(payload: string, secretHex: string): string {
  return nip44Encrypt(payload, getPublicKeyFromPrivate(secretHex), secretHex);
}

/** NIP-44 decrypt with the view keypair. Returns null on any failure. */
export function decryptWithViewKey<T>(
  ciphertext: string,
  secretHex: string
): T | null {
  try {
    const conversationKey = nip44ConversationKey(
      secretHex,
      getPublicKeyFromPrivate(secretHex)
    );
    const plaintext = nip44DecryptWithKey(ciphertext, conversationKey);
    return JSON.parse(plaintext) as T;
  } catch {
    return null;
  }
}

/** Payload tags for a private event (31923-style unix seconds + d + rrule). */
export function buildPrivateEventPayload(input: {
  dTag: string;
  title: string;
  description: string;
  startMs: number;
  endMs: number | null;
  location?: string;
  image?: string;
  rrule: string | null;
  /** Participant pubkeys (invites are sent separately as gift wraps). */
  participants?: string[];
}): string[][] {
  const tags: string[][] = [
    ['d', input.dTag],
    ['title', input.title],
    ['description', input.description],
    ['start', String(Math.floor(input.startMs / 1000))],
  ];
  if (input.endMs !== null) {
    tags.push(['end', String(Math.floor(input.endMs / 1000))]);
  }
  if (input.location) tags.push(['location', input.location]);
  if (input.image) tags.push(['image', input.image]);
  for (const participant of input.participants ?? []) {
    if (participant) tags.push(['p', participant]);
  }
  if (input.rrule) {
    tags.push(['L', 'rrule']);
    tags.push(['l', input.rrule]);
  }
  return tags;
}

/**
 * A parsed private calendar list (kind 32123). Encrypted payload format:
 *   [["title", …], ["content", …], ["color", …],
 *    ["a", "<coord>", "<relayHint>", "<viewSecretHex>"], …]
 */
export interface PrivateCalendarList {
  id: string;
  title: string;
  description: string;
  /** d-tag of the user's default list. */
  createdAt: number;
  eventRefs: PrivateEventRef[];
}

export interface PrivateEventRef {
  /** `<kind>:<pubkey>:<dTag>` of the private event. */
  coordinate: string;
  relayHint: string;
  viewSecretHex: string;
}

export const DEFAULT_PRIVATE_LIST_ID = 'noornote-private';

export function parsePrivateListPayload(
  plaintext: string,
  dTag: string,
  createdAt: number
): PrivateCalendarList | null {
  try {
    const tags = JSON.parse(plaintext) as unknown;
    if (!Array.isArray(tags)) return null;
    const list: PrivateCalendarList = {
      id: dTag,
      title: 'Private',
      description: '',
      createdAt,
      eventRefs: [],
    };
    for (const tag of tags as unknown[][]) {
      if (!Array.isArray(tag) || typeof tag[0] !== 'string') continue;
      switch (tag[0]) {
        case 'title':
          if (typeof tag[1] === 'string') list.title = tag[1];
          break;
        case 'content':
          if (typeof tag[1] === 'string') list.description = tag[1];
          break;
        case 'a':
          if (
            typeof tag[1] === 'string' &&
            typeof tag[3] === 'string' &&
            tag[1] &&
            tag[3]
          ) {
            list.eventRefs.push({
              coordinate: tag[1],
              relayHint: typeof tag[2] === 'string' ? tag[2] : '',
              viewSecretHex: tag[3],
            });
          }
          break;
      }
    }
    return list;
  } catch {
    return null;
  }
}

export function buildPrivateListPayload(
  list: Omit<PrivateCalendarList, 'id' | 'createdAt'>
): string {
  const tags: string[][] = [
    ['title', list.title],
    ['content', list.description],
  ];
  for (const ref of list.eventRefs) {
    tags.push(['a', ref.coordinate, ref.relayHint, ref.viewSecretHex]);
  }
  return JSON.stringify(tags);
}

export function isPrivateEventKind(kind: number | undefined): boolean {
  return kind === PRIVATE_EVENT_KIND || kind === PRIVATE_RECURRING_EVENT_KIND;
}
