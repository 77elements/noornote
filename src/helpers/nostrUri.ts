/**
 * Resolve a nostr: or web+nostr: URI to a router path.
 *
 * Strips URI prefixes, decodes the NIP-19 entity, and returns
 * the internal router path (e.g. /profile/npub1..., /note/nevent1...).
 * Returns null if the URI is invalid or unsupported.
 */

import { decodeNip19 } from '../services/NostrToolsAdapter';
import { hexToNpub } from './nip19';

export function resolveNostrUri(uri: string): string | null {
  try {
    // Strip protocol prefixes
    let nip19String = uri;
    if (nip19String.startsWith('web+nostr:')) {
      nip19String = nip19String.slice(10);
    } else if (nip19String.startsWith('nostr:')) {
      nip19String = nip19String.slice(6);
    }

    const decoded = decodeNip19(nip19String);

    if (decoded.type === 'npub') {
      return `/profile/${nip19String}`;
    }

    if (decoded.type === 'nprofile') {
      const npub = hexToNpub((decoded.data as { pubkey: string }).pubkey);
      return npub ? `/profile/${npub}` : null;
    }

    if (decoded.type === 'note' || decoded.type === 'nevent') {
      return `/note/${nip19String}`;
    }

    if (decoded.type === 'naddr') {
      return `/article/${nip19String}`;
    }

    return null;
  } catch {
    return null;
  }
}
