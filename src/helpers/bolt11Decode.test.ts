/**
 * Tests for bolt11Decode — BOLT11 decoder wrapper used by ZapService
 * payment verification (amount + description-hash checks).
 *
 * The fixtures below are REAL invoices, not synthetic ones: the BOLT11
 * spec's "1 cup coffee" example and the NIP-57 zap receipt example.
 * Testing against real wire data matters here — BOLT11 tagged fields are
 * 5-bit-word aligned, and a decoder that misinterprets lengths will still
 * round-trip against fixtures built in its own (wrong) format.
 */

import { describe, it, expect } from 'vitest';
import { decodeBolt11 } from './bolt11Decode';

// From the BOLT11 spec (https://github.com/lightning/bolts/blob/master/11-payment-encoding.md):
// lnbc2500u... = 2500 micro-BTC = 250_000 sats = 250_000_000 msats
const SPEC_EXAMPLE =
  'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';

// From NIP-57 Appendix E (zap receipt example, bolt11 tag):
// lnbc10u... = 10 micro-BTC = 1_000 sats = 1_000_000 msats
const NIP57_EXAMPLE =
  'lnbc10u1p3unwfusp5t9r3yymhpfqculx78u027lxspgxcr2n2987mx2j55nnfs95nxnzqpp5jmrh92pfld78spqs78v9euf2385t83uvpwk9ldrlvf6ch7tpascqhp5zvkrmemgth3tufcvflmzjzfvjt023nazlhljz2n9hattj4f8jq8qxqyjw5qcqpjrzjqtc4fc44feggv7065fqe5m4ytjarg3repr5j9el35xhmtfexc42yczarjuqqfzqqqqqqqqlgqqqqqqgq9q9qxpqysgq079nkq507a5tw7xgttmj4u990j7wfggtrasah5gd4ywfr2pjcn29383tphp4t48gquelz9z78p4cq7ml3nrrphw5w6eckhjwmhezhnqpy6gyf0';

describe('decodeBolt11', () => {
  it('decodes the BOLT11 spec example (amount + payment hash)', () => {
    const decoded = decodeBolt11(SPEC_EXAMPLE);
    expect(decoded).not.toBeNull();
    expect(decoded!.amountMsats).toBe(250_000_000);
    expect(decoded!.paymentHash).toBe(
      '0001020304050607080900010203040506070809000102030405060708090102'
    );
    // This invoice commits to a plain-text description ("d" field),
    // not a description hash ("h" field).
    expect(decoded!.descriptionHash).toBeNull();
  });

  it('decodes the NIP-57 zap invoice example (description hash)', () => {
    const decoded = decodeBolt11(NIP57_EXAMPLE);
    expect(decoded).not.toBeNull();
    expect(decoded!.amountMsats).toBe(1_000_000);
    expect(decoded!.descriptionHash).toBe(
      '132c3de7685de2be270c4ff629092c92dea8cfa2fdff212a65bf56b95527900e'
    );
    expect(decoded!.paymentHash).toBe(
      '96c772a829fb7c780410f1d85cf12a89e8b3c78c0bac5fb47f62758bf961ec30'
    );
  });

  it('returns null for a tampered invoice (checksum failure)', () => {
    // Flip a character in the data section — bech32 checksum must fail.
    const idx = NIP57_EXAMPLE.length - 10;
    const flipped =
      NIP57_EXAMPLE.slice(0, idx) +
      (NIP57_EXAMPLE[idx] === 'q' ? 'p' : 'q') +
      NIP57_EXAMPLE.slice(idx + 1);
    expect(decodeBolt11(flipped)).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(decodeBolt11('')).toBeNull();
    expect(decodeBolt11('not-an-invoice')).toBeNull();
    expect(decodeBolt11('lnbc1nope')).toBeNull();
  });
});
