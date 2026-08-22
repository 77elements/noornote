/**
 * Community Dhikr - admin moderation record.
 *
 * Dhikr rounds/commits are each their own event, signed by whoever created them, so they cannot be
 * deleted or edited by anyone else (a NIP-09 delete or a same-d-tag replace only works for the
 * original author). These events live ONLY on the two hardcoded dhikr relays and are rendered ONLY
 * by NoorNote, so moderation is done client-side instead: a single replaceable kind-30078 record,
 * signed by the fixed admin npub, that the client honors. Every client fetches it from the same two
 * relays, so hiding/overriding applies for everyone.
 *
 * The record carries three things, all keyed by the round's addressable ref (or the author pubkey):
 *   - hiddenRounds: round addrs to suppress from the list (reversible "delete").
 *   - bannedAuthors: pubkeys whose rounds disappear AND whose commit counts stop counting (their
 *     submissions are invalidated everywhere).
 *   - overrides: per-round field overrides (phrase/goal/description) for "edit".
 *
 * Only the admin's record counts: parseModeration rejects any event not signed by DHIKR_ADMIN_PUBKEY.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { npubToHex } from '../../helpers/nip19';
import { DHIKR_KIND, type DraftEvent } from './dhikr';

// The only npub allowed to moderate. Hex is derived once at load (null-safe).
export const DHIKR_ADMIN_NPUB =
  'npub175nul9cvufswwsnpy99lvyhg7ad9nkccxhkhusznxfkr7e0zxthql9g6w0';
export const DHIKR_ADMIN_PUBKEY = npubToHex(DHIKR_ADMIN_NPUB) ?? '';

export const MODERATION_LABEL = 'noornote-dhikr-moderation';
const MODERATION_DTAG = 'noornote/dhikr/moderation';

export interface DhikrOverride {
  phrase?: string;
  goal?: number;
  description?: string;
}

export interface DhikrModeration {
  hiddenRounds: string[]; // round addrs to suppress
  bannedAuthors: string[]; // pubkeys whose entries are invalidated
  overrides: Record<string, DhikrOverride>; // round addr -> field override
  createdAt: number; // event created_at (newest record wins)
}

export const EMPTY_MODERATION: DhikrModeration = {
  hiddenRounds: [],
  bannedAuthors: [],
  overrides: {},
  createdAt: 0,
};

function strArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((x): x is string => typeof x === 'string')
    : [];
}

/** Parse the admin moderation record, or null if it isn't one signed by the admin. */
export function parseModeration(ev: NostrEvent): DhikrModeration | null {
  if (ev.pubkey !== DHIKR_ADMIN_PUBKEY) return null; // only the admin's record is honored
  const d = ev.tags.find(t => t[0] === 'd')?.[1];
  if (d !== MODERATION_DTAG) return null;
  try {
    const body = JSON.parse(ev.content || '{}');
    const overrides: Record<string, DhikrOverride> =
      body.overrides && typeof body.overrides === 'object'
        ? body.overrides
        : {};
    return {
      hiddenRounds: strArray(body.hiddenRounds),
      bannedAuthors: strArray(body.bannedAuthors),
      overrides,
      createdAt: ev.created_at,
    };
  } catch {
    return null;
  }
}

/** Build the unsigned moderation record (DhikrService signs + publishes it). Replaceable: stable d. */
export function buildModerationDraft(m: DhikrModeration): DraftEvent {
  return {
    kind: DHIKR_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', MODERATION_DTAG],
      ['t', MODERATION_LABEL],
    ],
    content: JSON.stringify({
      hiddenRounds: m.hiddenRounds,
      bannedAuthors: m.bannedAuthors,
      overrides: m.overrides,
    }),
  };
}
