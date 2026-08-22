/**
 * NIP-05 resolver: handle ("name@domain") → pubkey + optional relay hints.
 *
 * Standard NIP-05 lookup against `https://{domain}/.well-known/nostr.json?name={name}`.
 * Returns null on any failure (network, malformed JSON, missing pubkey, CORS) —
 * callers should treat null as "handle did not resolve".
 * No relay hints are followed automatically; that is left to the caller.
 *
 * In-memory result cache with 1h TTL — browser HTTP cache cannot be relied
 * upon (server may set no-cache, CDN behavior varies); repeated lookups of the
 * same handle within the TTL become memory reads.
 */

export interface Nip05Resolution {
  pubkey: string;
  relays?: string[];
}

interface CacheEntry {
  result: Nip05Resolution | null;
  fetchedAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

export async function resolveNip05(
  handle: string
): Promise<Nip05Resolution | null> {
  const trimmed = handle.trim();
  const at = trimmed.indexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;

  const name = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (!domain.includes('.')) return null;

  const cacheKey = `${name.toLowerCase()}@${domain.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.result;
  }

  const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;

  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      cache.set(cacheKey, { result: null, fetchedAt: Date.now() });
      return null;
    }
    const data = (await res.json()) as {
      names?: Record<string, string>;
      relays?: Record<string, string[]>;
    };
    const pubkey = data.names?.[name];
    if (
      !pubkey ||
      typeof pubkey !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(pubkey)
    ) {
      cache.set(cacheKey, { result: null, fetchedAt: Date.now() });
      return null;
    }

    const relays = data.relays?.[pubkey];
    const result: Nip05Resolution =
      relays && Array.isArray(relays) ? { pubkey, relays } : { pubkey };
    cache.set(cacheKey, { result, fetchedAt: Date.now() });
    return result;
  } catch {
    // Don't cache transient network errors — let the next call retry.
    return null;
  }
}
