/**
 * Tests for the NIP-57 payment-safety gates in ZapService:
 *
 * - getZapEndpoint: the LNURL callback URL receives the full signed zap
 *   request (pubkey, amount, relays, target) as a query parameter. A
 *   non-https callback would send it in plaintext (wire + server/proxy
 *   logs) and is refused.
 * - fetchInvoice: the `pr` invoice comes from a third-party (potentially
 *   malicious) server and must be verified BEFORE it is handed to the
 *   wallet: invoice amount must not exceed the requested amount, and the
 *   invoice's description hash must equal SHA-256 of the exact zap request
 *   JSON we sent (proves the invoice was minted for THIS zap request).
 *
 * Invoice fixtures are built in-test via bech32 + tagged fields. The
 * decoder used by ZapService (light-bolt11-decoder) verifies the bech32
 * checksum and structure but not the node signature — irrelevant here,
 * since ZapService only reads self-describing fields. The description
 * hashes in the fixtures are computed with the same @noble sha256 the
 * production code uses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bech32 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

const ME = 'a'.repeat(64);
const AUTHOR = 'b'.repeat(64);
const NOTE = 'c'.repeat(64);

const { loggerMock, fetchMock, store } = vi.hoisted(() => {
  const loggerMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const fetchMock = vi.fn();
  const store = new Map<string, unknown>();
  return {
    loggerMock,
    fetchMock,
    store,
  };
});

vi.mock('./NWCService', () => ({
  NWCService: { getInstance: () => ({ isConnected: () => false }) },
}));
vi.mock('./transport/NostrTransport', () => ({
  NostrTransport: { getInstance: () => ({}) },
}));
vi.mock('./PerAccountLocalStorage', () => ({
  PerAccountLocalStorage: {
    getInstance: () => ({
      get: (key: string, fallback: unknown) => fallback,
      set: () => undefined,
      delete: () => undefined,
    }),
  },
  StorageKeys: {
    USER_ZAPS: 'user_zaps',
    OWN_ANON_ZAP_INVOICES: 'own_anon_zaps',
  },
}));
vi.mock('./AuthService', () => ({
  AuthService: {
    getInstance: () => ({ getCurrentUser: () => ({ pubkey: ME }) }),
  },
}));
vi.mock('./SystemLogger', () => ({
  SystemLogger: { getInstance: () => loggerMock },
}));
vi.mock('./ErrorService', () => ({
  ErrorService: { getInstance: () => ({ catch: vi.fn() }) },
}));
vi.mock('./ToastService', () => ({
  ToastService: { show: vi.fn() },
}));
vi.mock('./RelayConfig', () => ({
  RelayConfig: {
    getInstance: () => ({ getReadRelays: () => ['wss://relay.test'] }),
  },
}));
vi.mock('./UserProfileService', () => ({
  UserProfileService: { getInstance: () => ({ getUserProfile: vi.fn() }) },
}));
vi.mock('./orchestration/OutboundRelaysOrchestrator', () => ({
  OutboundRelaysOrchestrator: { getInstance: () => ({}) },
}));
vi.mock('./orchestration/ProfileOrchestrator', () => ({
  ProfileOrchestrator: { getInstance: () => ({}) },
}));
vi.mock('./security/SignatureVerificationService', () => ({
  SignatureVerificationService: {
    getInstance: () => ({ verifyEvent: () => ({ valid: true }) }),
  },
}));
vi.mock('./PlatformService', () => ({
  PlatformService: {
    getInstance: () => ({ isBrowser: false, isDesktop: false }),
  },
}));
vi.mock('./NostrToolsAdapter', () => ({
  generateSecretKey: () => new Uint8Array(32),
  finalizeEvent: (event: unknown) => event,
}));

import { ZapService } from './ZapService';

type AnyFn = (...args: unknown[]) => unknown;

// ── BOLT11 fixture builder ──────────────────────────────────────────────

/** Big-endian value as `wordCount` 5-bit words (timestamps up to 2^35). */
function intToWords(value: number, wordCount: number): number[] {
  const words = new Array<number>(wordCount).fill(0);
  for (let i = wordCount - 1; i >= 0; i--) {
    words[i] = value % 32;
    value = Math.floor(value / 32);
  }
  return words;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** One tagged field: type word + 10-bit length (2 words) + payload words. */
function tagWords(type: number, payload: Uint8Array): number[] {
  const words = Array.from(bech32.toWords(payload));
  return [type, ...intToWords(words.length, 2), ...words];
}

/** msat → HRP amount via the `p` multiplier (1 p = 10^-12 BTC = 0.1 msat,
 *  so 1 msat = 10 p-units). Works for any whole-msat amount. */
function hrpAmount(millisats: number): string {
  return `${millisats * 10}p`;
}

/**
 * Builds a decodable BOLT11 invoice. The 65-byte signature block is a
 * fixed placeholder: the decoder verifies the bech32 checksum (computed
 * by bech32.encode) and structure, but not the node signature.
 */
function buildInvoice(opts: {
  amountMillisats?: number;
  descriptionHashHex?: string;
}): string {
  let words = intToWords(Math.floor(Date.now() / 1000), 7);
  if (opts.descriptionHashHex) {
    words = words.concat(tagWords(23, hexToBytes(opts.descriptionHashHex)));
  }
  words = words.concat(Array.from(bech32.toWords(new Uint8Array(65))));
  const hrp = `lnbc${opts.amountMillisats ? hrpAmount(opts.amountMillisats) : ''}`;
  return bech32.encode(hrp, words, Number.MAX_SAFE_INTEGER);
}

// ── fixture zap request (kind 9734) ─────────────────────────────────────

const ZAP_REQUEST = {
  pubkey: ME,
  content: '',
  created_at: 1679673265,
  kind: 9734,
  tags: [
    ['relays', 'wss://relay.test'],
    ['amount', '1000'],
    ['p', AUTHOR],
    ['e', NOTE],
  ],
  id: 'aa'.repeat(32),
  sig: 'bb'.repeat(64),
};
const ZAP_JSON = JSON.stringify(ZAP_REQUEST);
const ZAP_HASH = bytesToHex(sha256(utf8ToBytes(ZAP_JSON)));
const WRONG_HASH = 'ff'.repeat(32);

// ── service helper ──────────────────────────────────────────────────────

function newService(): ZapService {
  (ZapService as unknown as { instance: ZapService | null }).instance = null;
  const svc = ZapService.getInstance();
  (svc as unknown as Record<string, AnyFn>).fetchWithTimeout = fetchMock;
  return svc;
}

function mockHttpResponse(body: unknown): void {
  fetchMock.mockResolvedValue({ ok: true, json: async () => body });
}

beforeEach(() => {
  fetchMock.mockReset();
  loggerMock.info.mockClear();
  loggerMock.warn.mockClear();
  loggerMock.error.mockClear();
  store.clear();
});

// ── tests ───────────────────────────────────────────────────────────────

describe('ZapService.getZapEndpoint — https-only callback gate', () => {
  const lnurlPayBody = (callback: string) => ({
    allowsNostr: true,
    nostrPubkey: AUTHOR,
    callback,
  });

  it('accepts an https callback and returns callback + lnurl', async () => {
    const svc = newService();
    mockHttpResponse(lnurlPayBody('https://wallet.test/lnurlp/cb'));

    const endpoint = await (
      svc as unknown as Record<string, AnyFn>
    ).getZapEndpoint({ lud16: 'user@example.com' });

    expect(endpoint).toEqual({
      callback: 'https://wallet.test/lnurlp/cb',
      lnurl: 'https://example.com/.well-known/lnurlp/user',
    });
  });

  it('refuses an http callback (zap request would travel in plaintext)', async () => {
    const svc = newService();
    mockHttpResponse(lnurlPayBody('http://wallet.test/lnurlp/cb'));

    const endpoint = await (
      svc as unknown as Record<string, AnyFn>
    ).getZapEndpoint({ lud16: 'user@example.com' });

    expect(endpoint).toBeNull();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'ZapService',
      expect.stringContaining('https')
    );
  });
});

describe('ZapService.fetchInvoice — verify invoice before wallet handoff', () => {
  function fetchInvoice(svc: ZapService, event: unknown, amountSats: number) {
    return (svc as unknown as Record<string, AnyFn>).fetchInvoice(
      'https://wallet.test/lnurlp/cb',
      event,
      amountSats
    );
  }

  it('pays a well-formed invoice (amount + description hash match)', async () => {
    const svc = newService();
    const pr = buildInvoice({
      amountMillisats: 1_000_000,
      descriptionHashHex: ZAP_HASH,
    });
    mockHttpResponse({ pr });

    const invoice = await fetchInvoice(svc, ZAP_REQUEST, 1000);

    expect(invoice).toBe(pr);
    expect(loggerMock.error).not.toHaveBeenCalled();
  });

  it('refuses an invoice whose description hash does not match the zap request', async () => {
    const svc = newService();
    // Invoice was minted for a DIFFERENT zap request (substitution attack).
    mockHttpResponse({
      pr: buildInvoice({
        amountMillisats: 1_000_000,
        descriptionHashHex: WRONG_HASH,
      }),
    });

    const invoice = await fetchInvoice(svc, ZAP_REQUEST, 1000);

    expect(invoice).toBeNull();
    expect(loggerMock.error).toHaveBeenCalledWith(
      'ZapService',
      expect.stringContaining('description hash')
    );
  });

  it('refuses an invoice without a description hash', async () => {
    const svc = newService();
    mockHttpResponse({ pr: buildInvoice({ amountMillisats: 1_000_000 }) });

    const invoice = await fetchInvoice(svc, ZAP_REQUEST, 1000);

    expect(invoice).toBeNull();
  });

  it('refuses an invoice for more than the requested amount', async () => {
    const svc = newService();
    // User asked for 999 sats, server returned a 1000-sat invoice.
    mockHttpResponse({
      pr: buildInvoice({
        amountMillisats: 1_000_000,
        descriptionHashHex: ZAP_HASH,
      }),
    });

    const invoice = await fetchInvoice(svc, ZAP_REQUEST, 999);

    expect(invoice).toBeNull();
    expect(loggerMock.error).toHaveBeenCalledWith(
      'ZapService',
      expect.stringContaining('overpay'),
      expect.anything()
    );
  });

  it('tolerates an invoice below the requested amount (warn only)', async () => {
    const svc = newService();
    const pr = buildInvoice({
      amountMillisats: 1_000_000,
      descriptionHashHex: ZAP_HASH,
    });
    mockHttpResponse({ pr });

    // User asked for 2000 sats, server rounded down to 1000.
    const invoice = await fetchInvoice(svc, ZAP_REQUEST, 2000);

    expect(invoice).toBe(pr);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'ZapService',
      expect.stringContaining('under'),
      expect.anything()
    );
  });

  it('accepts an amountless invoice (wallet decides amount, hash still binds)', async () => {
    const svc = newService();
    const pr = buildInvoice({ descriptionHashHex: ZAP_HASH });
    mockHttpResponse({ pr });

    const invoice = await fetchInvoice(svc, ZAP_REQUEST, 1000);

    expect(invoice).toBe(pr);
  });

  it('refuses an unparseable invoice', async () => {
    const svc = newService();
    mockHttpResponse({ pr: 'not-an-invoice' });

    const invoice = await fetchInvoice(svc, ZAP_REQUEST, 1000);

    expect(invoice).toBeNull();
  });
});
