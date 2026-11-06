/**
 * bolt11Decode — thin wrapper around light-bolt11-decoder for payment
 * verification.
 *
 * Purpose: NIP-57 zap safety. Before paying an invoice returned by a
 * (potentially malicious) LNURL server, the client must verify that the
 * invoice's embedded amount matches what the user requested, and that the
 * invoice belongs to the zap request it was issued for (description hash
 * check). See NIP-57 and the ZapService.fetchInvoice validation.
 *
 * We use fiatjaf's light-bolt11-decoder (already a dependency of
 * @nostr-dev-kit/ndk) instead of hand-rolling the BOLT11 wire format:
 * tagged fields are 5-bit-word aligned (lengths are word counts, not byte
 * counts), which is easy to get subtly wrong. The library does not verify
 * the invoice's node signature — that is fine here, we only read the
 * invoice's self-describing fields; bech32 checksum integrity is still
 * fully verified.
 */

import { decode } from 'light-bolt11-decoder';

export interface Bolt11Decoded {
  /** Amount in millisats parsed from the human-readable part (null if none) */
  amountMsats: number | null;
  /** SHA-256 description hash, hex (tag type 23, the "h" field), or null */
  descriptionHash: string | null;
  /** SHA-256 payment hash, hex (tag type 1, the "p" field), or null */
  paymentHash: string | null;
  /** Payee node pubkey, hex (tag type 19, the "n" field), or null */
  payeePubkey: string | null;
}

/** Loosened section shape — the library's .d.ts omits some section names. */
interface LooseSection {
  name: string;
  value?: unknown;
}

/**
 * Decode a BOLT11 invoice string and extract the fields needed for
 * payment verification. Returns null for any malformed/invalid invoice
 * (bad checksum, unknown structure).
 */
export function decodeBolt11(invoice: string): Bolt11Decoded | null {
  try {
    const decoded = decode(invoice.trim());
    const sections = decoded.sections as LooseSection[];

    const str = (name: string): string | null => {
      const section = sections.find(s => s.name === name);
      return typeof section?.value === 'string' ? section.value : null;
    };

    const amountSection = sections.find(s => s.name === 'amount');
    const raw = amountSection ? Number(amountSection.value) : Number.NaN;

    return {
      amountMsats: Number.isFinite(raw) ? raw : null,
      descriptionHash: str('description_hash'),
      paymentHash: str('payment_hash'),
      payeePubkey: str('payee'),
    };
  } catch {
    return null;
  }
}
