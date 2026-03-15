/**
 * Encrypt private follow list items using NIP-44 with NIP-04 fallback
 * Automatically detects auth method (browser extension, KeySigner, or NIP-46)
 * Used for NIP-51 private follow lists
 *
 * Fallback Logic:
 * 1. Try NIP-44 encryption first (modern, recommended)
 * 2. If NIP-44 fails → fall back to NIP-04 (legacy)
 * 3. If both fail → throw error
 *
 * @param pubkeys - Array of hex pubkeys to encrypt
 * @param authorPubkey - Author's public key (for self-encryption)
 * @returns Base64-encoded encrypted payload
 * @throws Error if all encryption methods fail
 *
 * @example
 * const encrypted = await encryptPrivateFollows(
 *   ['abc123...', 'def456...'],
 *   myPubkey
 * );
 */

import { diagLog } from '../services/DiagnosticLogger';

export async function encryptPrivateFollows(
  pubkeys: string[],
  authorPubkey: string
): Promise<string> {
  // Convert to NIP-51 tag array format
  const privateTags: string[][] = pubkeys.map(pubkey => ['p', pubkey]);

  // Serialize to JSON
  const plaintext = JSON.stringify(privateTags);
  diagLog('lists', 'encryptPrivateFollows: encrypting', { count: pubkeys.length, plaintextLength: plaintext.length });

  // Detect auth method and encrypt accordingly
  const { AuthService } = await import('../services/AuthService');
  const authService = AuthService.getInstance();
  const authMethod = authService.getAuthMethod();
  diagLog('lists', 'encryptPrivateFollows: authMethod', { authMethod });

  if (authMethod === 'key-signer') {
    // Use KeySigner for encryption (NIP-44 → NIP-04 fallback)
    const { KeySignerClient } = await import('../services/KeySignerClient');
    const keySigner = KeySignerClient.getInstance();

    try {
      // Try NIP-44 first
      const encrypted = await keySigner.nip44Encrypt(plaintext, authorPubkey);
      return encrypted;
    } catch (nip44Error) {
      // Fallback to NIP-04
      try {
        const encrypted = await keySigner.nip04Encrypt(plaintext, authorPubkey);
        return encrypted;
      } catch (nip04Error) {
        throw new Error(`Encryption failed: NIP-44 (${nip44Error}), NIP-04 (${nip04Error})`);
      }
    }
  } else if (authMethod === 'extension') {
    // Use browser extension (NIP-44 → NIP-04 fallback)
    try {
      // Try NIP-44 first
      if (window.nostr?.nip44?.encrypt) {
        const encrypted = await window.nostr.nip44.encrypt(authorPubkey, plaintext);
        return encrypted;
      }
      throw new Error('NIP-44 not available');
    } catch (nip44Error) {
      // Fallback to NIP-04
      if (!window.nostr?.nip04?.encrypt) {
        throw new Error('Browser extension does not support NIP-44 or NIP-04 encryption');
      }
      try {
        const encrypted = await window.nostr.nip04.encrypt(authorPubkey, plaintext);
        return encrypted;
      } catch (nip04Error) {
        throw new Error(`Encryption failed: NIP-44 (${nip44Error}), NIP-04 (${nip04Error})`);
      }
    }
  } else if (authMethod === 'nip46') {
    // Use NIP-46 remote signer for encryption (NIP-44 → NIP-04 fallback)
    const { AuthService } = await import('../services/AuthService');
    const nip46Manager = (AuthService.getInstance() as any).nip46Manager;

    if (!nip46Manager?.isAvailable()) {
      throw new Error('NIP-46 remote signer not available');
    }

    try {
      // Try NIP-44 first
      const encrypted = await nip46Manager.nip44Encrypt(plaintext, authorPubkey);
      return encrypted;
    } catch (nip44Error) {
      // Fallback to NIP-04
      try {
        const encrypted = await nip46Manager.nip04Encrypt(plaintext, authorPubkey);
        return encrypted;
      } catch (nip04Error) {
        throw new Error(`Encryption failed: NIP-44 (${nip44Error}), NIP-04 (${nip04Error})`);
      }
    }
  } else {
    throw new Error('No auth method available for NIP-44 encryption');
  }
}
