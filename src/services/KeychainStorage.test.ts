// @vitest-environment jsdom
/**
 * KeychainStorage — NWC eviction-recovery regression tests (web).
 *
 * Browser scenario: an IndexedDB eviction wipes BOTH `noornote_secure` (NWC
 * ciphertext) and `noornote_device` (device key). Recovery works because
 *   - the ciphertext is mirrored to per-account localStorage
 *     (KeychainStorage NWC_BLOB_MIRROR), and
 *   - the device key is mirrored to device-level localStorage
 *     (NWCCryptoService `noornote_device_key_mirror`) — without it a fresh
 *     random key cannot decrypt the mirrored ciphertext and the wallet
 *     connection would be lost (see docs/features/indexeddb-eviction-nwc-dm.md).
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { palStore } = vi.hoisted(() => ({
  palStore: new Map<string, unknown>(),
}));

// DiagnosticLogger pulls transitively AuthService → signer managers →
// ProfileOrchestrator (reads localStorage on module level) — no-op it.
vi.mock('./DiagnosticLogger', () => ({ diagLog: () => {} }));

vi.mock('./AuthService', () => ({
  AuthService: {
    getInstance: () => ({
      getCurrentUser: () => ({ pubkey: HEX }),
    }),
  },
}));

// Map-backed per-account localStorage — KeychainStorage only uses the
// *ForPubkey trio on the NWC paths.
vi.mock('./PerAccountLocalStorage', () => ({
  PerAccountLocalStorage: {
    getInstance: () => ({
      setForPubkey: (_key: string, pubkey: string, value: unknown) => {
        palStore.set(`${_key}:${pubkey}`, value);
      },
      getForPubkey: <T>(_key: string, pubkey: string, defaultValue: T): T =>
        (palStore.has(`${_key}:${pubkey}`)
          ? palStore.get(`${_key}:${pubkey}`)
          : defaultValue) as T,
      removeForPubkey: (_key: string, pubkey: string) => {
        palStore.delete(`${_key}:${pubkey}`);
      },
    }),
  },
  StorageKeys: {
    NWC_BLOB_MIRROR: 'nwc_blob_mirror_test',
    ZAP_DEFAULTS: 'zap_defaults_test',
    FIAT_CURRENCY: 'fiat_test',
  },
}));

import { KeychainStorage } from './KeychainStorage';
import { NWCCryptoService } from './NWCCryptoService';

const HEX = 'a'.repeat(64);
const NWC = 'nostr+walletconnect:abc?relay=wss://r&secret=topsecret';
const MIRROR_KEY = 'noornote_device_key_mirror';

/** Reset NWCCryptoService in-memory key cache — simulates an app restart. */
function freshCrypto(): void {
  (NWCCryptoService as unknown as { instance: null }).instance = null;
}

/** Simulate an IndexedDB eviction: wipe records of one origin database. */
async function evictDb(dbName: string, store: string): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(dbName);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('open failed'));
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('clear failed'));
  });
  db.close();
}

beforeEach(() => {
  localStorage.clear();
  palStore.clear();
  freshCrypto();
});

describe('KeychainStorage NWC eviction recovery (web)', () => {
  it('saves and loads an NWC string (round trip)', async () => {
    await KeychainStorage.saveNWC(NWC, HEX);
    expect(await KeychainStorage.loadNWC(HEX)).toBe(NWC);
  });

  it('writes the ciphertext mirror to per-account localStorage on save', async () => {
    await KeychainStorage.saveNWC(NWC, HEX);
    expect(palStore.has(`nwc_blob_mirror_test:${HEX}`)).toBe(true);
  });

  it('recovers from the blob mirror after a ciphertext-DB eviction', async () => {
    await KeychainStorage.saveNWC(NWC, HEX);
    await evictDb('noornote_secure', 'keychain');
    expect(await KeychainStorage.loadNWC(HEX)).toBe(NWC);
  });

  it('recovers after a FULL eviction (ciphertext + device key wiped)', async () => {
    await KeychainStorage.saveNWC(NWC, HEX);
    await evictDb('noornote_secure', 'keychain');
    await evictDb('noornote_device', 'keychain');
    freshCrypto(); // restart: in-memory key cache is gone too
    // 1.6.1 regression: without the key mirror this returned null and the
    // wallet connection was lost.
    expect(await KeychainStorage.loadNWC(HEX)).toBe(NWC);
  });

  it('returns null when everything is gone (fresh device)', async () => {
    await KeychainStorage.saveNWC(NWC, HEX);
    await evictDb('noornote_secure', 'keychain');
    await evictDb('noornote_device', 'keychain');
    localStorage.removeItem(MIRROR_KEY);
    palStore.clear();
    freshCrypto();
    expect(await KeychainStorage.loadNWC(HEX)).toBeNull();
  });

  it('deleteNWC clears both the ciphertext and its mirror', async () => {
    await KeychainStorage.saveNWC(NWC, HEX);
    await KeychainStorage.deleteNWC(HEX);
    expect(palStore.has(`nwc_blob_mirror_test:${HEX}`)).toBe(false);
    expect(await KeychainStorage.loadNWC(HEX)).toBeNull();
  });
});
