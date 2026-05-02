/**
 * NIP-05 resolver: handle ("name@domain") → pubkey + optional relay hints.
 *
 * Standard NIP-05 lookup against `https://{domain}/.well-known/nostr.json?name={name}`.
 * Returns null on any failure (network, malformed JSON, missing pubkey, CORS) —
 * callers should treat null as "handle did not resolve".
 *
 * This is the read-side resolver used by the public NosPress page boot path.
 * No relay hints are followed automatically; that is left to the caller.
 */

export interface Nip05Resolution {
  pubkey: string;
  relays?: string[];
}

export async function resolveNip05(handle: string): Promise<Nip05Resolution | null> {
  const trimmed = handle.trim();
  const at = trimmed.indexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;

  const name = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (!domain.includes('.')) return null;

  const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;

  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json() as { names?: Record<string, string>; relays?: Record<string, string[]> };
    const pubkey = data.names?.[name];
    if (!pubkey || typeof pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(pubkey)) return null;

    const relays = data.relays?.[pubkey];
    return relays && Array.isArray(relays) ? { pubkey, relays } : { pubkey };
  } catch {
    return null;
  }
}
