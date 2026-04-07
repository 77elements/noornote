/**
 * Extract BOLT11 Lightning invoices from note content.
 *
 * There is no NIP for embedded Lightning invoices — it's a client convention.
 * Some users paste raw `lnbc...` strings, optionally prefixed with `lightning:`
 * or the non-standard `nostr:` scheme (used by Primal).
 *
 * Reference implementation: Amethyst LnInvoiceUtil.kt
 */

import { parseBolt11Amount } from './zapUtils';

export interface Bolt11Match {
  invoice: string;   // raw lnbc... string (without prefix)
  fullMatch: string; // what to replace in content (incl. prefix if present)
  amount: number;    // in sats
}

// Matches lnbc invoices with optional prefix. Case-insensitive.
// Must start with lnbc + amount + multiplier marker + "1" (separator).
const BOLT11_REGEX = /(?:lightning:|nostr:)?(lnbc(?:\d+[munp]?)?1[02-9ac-hj-np-z]+)/gi;

export function extractBolt11(content: string): Bolt11Match[] {
  const results: Bolt11Match[] = [];
  const seen = new Set<string>();

  const matches = content.matchAll(BOLT11_REGEX);
  for (const match of matches) {
    const fullMatch = match[0];
    const invoice = match[1];
    if (!invoice) continue;

    // Avoid false positives from short random strings.
    if (invoice.length < 50) continue;

    // Deduplicate exact same invoice appearing multiple times.
    if (seen.has(invoice)) continue;
    seen.add(invoice);

    // Must decode to a valid amount > 0. If not, skip.
    const amount = parseBolt11Amount(invoice);
    if (amount <= 0) continue;

    results.push({ invoice, fullMatch, amount });
  }

  return results;
}
