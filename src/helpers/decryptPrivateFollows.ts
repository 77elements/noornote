/**
 * Decrypt private follow list items using NIP-44/NIP-04 with fallback
 * Automatically detects auth method (browser extension, KeySigner, or NIP-46)
 * Used for NIP-51 private follow lists with backward compatibility
 *
 * Fallback Logic:
 * 1. Auto-detect format (NIP-44 vs NIP-04 via `?iv=` check)
 * 2. Try the detected protocol first
 * 3. If it fails → try the other protocol
 * 4. If both fail → return empty array (graceful failure)
 *
 * @param encryptedContent - Base64-encoded encrypted payload from event.content
 * @param authorPubkey - Author's public key (for self-decryption)
 * @returns Array of decrypted hex pubkeys
 *
 * @example
 * const pubkeys = await decryptPrivateFollows(
 *   event.content,
 *   authorPubkey
 * );
 */
export async function decryptPrivateFollows(
  encryptedContent: string,
  authorPubkey: string
): Promise<string[]> {
  // Empty content = no private follows
  if (!encryptedContent || encryptedContent.trim() === '') {
    return [];
  }

  try {
    // Auto-detect NIP-04 vs NIP-44 (backward compatibility)
    const isNip04 = encryptedContent.includes('?iv=');

    let plaintext: string | null = null;

    // Detect auth method
    const { AuthService } = await import('../services/AuthService');
    const authService = AuthService.getInstance();
    const authMethod = authService.getAuthMethod();

    if (authMethod === 'key-signer') {
      // Use KeySigner for decryption
      const { KeySignerClient } = await import('../services/KeySignerClient');
      const keySigner = KeySignerClient.getInstance();

      if (isNip04) {
        // Try NIP-04 first, then NIP-44 fallback
        try {
          plaintext = await keySigner.nip04Decrypt(encryptedContent, authorPubkey);
        } catch (_nip04Error) {
          try {
            plaintext = await keySigner.nip44Decrypt(encryptedContent, authorPubkey);
          } catch (_nip44Error) {
            return [];
          }
        }
      } else {
        // Try NIP-44 first, then NIP-04 fallback
        try {
          plaintext = await keySigner.nip44Decrypt(encryptedContent, authorPubkey);
        } catch (_nip44Error) {
          try {
            plaintext = await keySigner.nip04Decrypt(encryptedContent, authorPubkey);
          } catch (_nip04Error) {
            return [];
          }
        }
      }
    } else if (authMethod === 'extension') {
      // Use browser extension
      if (isNip04) {
        // Try NIP-04 first, then NIP-44 fallback
        try {
          if (!window.nostr?.nip04?.decrypt) {
            throw new Error('NIP-04 not available');
          }
          plaintext = await window.nostr.nip04.decrypt(authorPubkey, encryptedContent);
        } catch (_nip04Error) {
          try {
            if (!window.nostr?.nip44?.decrypt) {
              throw new Error('NIP-44 not available');
            }
            plaintext = await window.nostr.nip44.decrypt(authorPubkey, encryptedContent);
          } catch (_nip44Error) {
            return [];
          }
        }
      } else {
        // Try NIP-44 first, then NIP-04 fallback
        try {
          if (!window.nostr?.nip44?.decrypt) {
            throw new Error('NIP-44 not available');
          }
          plaintext = await window.nostr.nip44.decrypt(authorPubkey, encryptedContent);
        } catch (_nip44Error) {
          try {
            if (!window.nostr?.nip04?.decrypt) {
              throw new Error('NIP-04 not available');
            }
            plaintext = await window.nostr.nip04.decrypt(authorPubkey, encryptedContent);
          } catch (_nip04Error) {
            return [];
          }
        }
      }
    } else if (authMethod === 'nip46') {
      // Use NIP-46 remote signer for decryption
      const { AuthService } = await import('../services/AuthService');
      const nip46Manager = (AuthService.getInstance() as any).nip46Manager;

      if (!nip46Manager?.isAvailable()) {
        return [];
      }

      if (isNip04) {
        // Try NIP-04 first, then NIP-44 fallback
        try {
          plaintext = await nip46Manager.nip04Decrypt(encryptedContent, authorPubkey);
        } catch (_nip04Error) {
          try {
            plaintext = await nip46Manager.nip44Decrypt(encryptedContent, authorPubkey);
          } catch (_nip44Error) {
            return [];
          }
        }
      } else {
        // Try NIP-44 first, then NIP-04 fallback
        try {
          plaintext = await nip46Manager.nip44Decrypt(encryptedContent, authorPubkey);
        } catch (_nip44Error) {
          try {
            plaintext = await nip46Manager.nip04Decrypt(encryptedContent, authorPubkey);
          } catch (_nip04Error) {
            return [];
          }
        }
      }
    } else {
      return [];
    }

    if (!plaintext) {
      return [];
    }

    // Parse JSON to get tag array
    const privateTags: string[][] = JSON.parse(plaintext);

    // Validate structure
    if (!Array.isArray(privateTags)) {
      return [];
    }

    // Extract pubkeys from ["p", "pubkey"] tags
    const pubkeys = privateTags
      .filter((tag): tag is [string, string, ...string[]] => Array.isArray(tag) && tag[0] === 'p' && typeof tag[1] === 'string')
      .map(tag => tag[1]);

    return pubkeys;
  } catch (_error) {
    return []; // Fail gracefully
  }
}
