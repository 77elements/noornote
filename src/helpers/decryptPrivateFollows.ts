/**
 * Decrypt private follow list items using NIP-44/NIP-04 with fallback
 * Uses AuthService which routes to the correct signer automatically.
 * Used for NIP-51 private follow lists with backward compatibility
 *
 * Fallback Logic:
 * 1. Auto-detect format (NIP-44 vs NIP-04 via `?iv=` check)
 * 2. Try the detected protocol first
 * 3. If it fails, try the other protocol
 * 4. If both fail, return empty array (graceful failure)
 *
 * @param encryptedContent - Base64-encoded encrypted payload from event.content
 * @param authorPubkey - Author's public key (for self-decryption)
 * @returns Array of decrypted hex pubkeys
 */

import { diagLog } from '../services/DiagnosticLogger';

export async function decryptPrivateFollows(
  encryptedContent: string,
  authorPubkey: string
): Promise<string[]> {
  if (!encryptedContent || encryptedContent.trim() === '') {
    diagLog('lists', 'decryptPrivateFollows: empty content, skipping');
    return [];
  }

  diagLog('lists', 'decryptPrivateFollows: attempting decryption', { contentLength: encryptedContent.length });

  try {
    const { AuthService } = await import('../services/AuthService');
    const authService = AuthService.getInstance();

    if (authService.isBunkerAuth()) {
      diagLog('lists', 'decryptPrivateFollows: skipping — bunker auth');
      return [];
    }

    // Auto-detect NIP-04 vs NIP-44 (backward compatibility)
    const isNip04 = encryptedContent.includes('?iv=');
    diagLog('lists', 'decryptPrivateFollows: detected format', { format: isNip04 ? 'NIP-04' : 'NIP-44' });

    // Try detected protocol first, then fallback to the other
    const primaryDecrypt = isNip04
      ? authService.nip04Decrypt.bind(authService)
      : authService.nip44Decrypt.bind(authService);
    const fallbackDecrypt = isNip04
      ? authService.nip44Decrypt.bind(authService)
      : authService.nip04Decrypt.bind(authService);

    let plaintext: string;
    try {
      plaintext = await primaryDecrypt(encryptedContent, authorPubkey);
      diagLog('lists', 'decryptPrivateFollows: primary decrypt succeeded');
    } catch (primaryError) {
      diagLog('lists', 'decryptPrivateFollows: primary decrypt failed, trying fallback', { error: String(primaryError) });
      try {
        plaintext = await fallbackDecrypt(encryptedContent, authorPubkey);
        diagLog('lists', 'decryptPrivateFollows: fallback decrypt succeeded');
      } catch (fallbackError) {
        diagLog('lists', 'decryptPrivateFollows: BOTH decryption methods FAILED — private follows LOST', { primaryError: String(primaryError), fallbackError: String(fallbackError) });
        return [];
      }
    }

    if (!plaintext) {
      diagLog('lists', 'decryptPrivateFollows: decryption returned empty — private follows LOST');
      return [];
    }

    const privateTags: string[][] = JSON.parse(plaintext);

    if (!Array.isArray(privateTags)) {
      diagLog('lists', 'decryptPrivateFollows: parsed result is not an array', { type: typeof privateTags });
      return [];
    }

    const pubkeys = privateTags
      .filter((tag): tag is [string, string, ...string[]] => Array.isArray(tag) && tag[0] === 'p' && typeof tag[1] === 'string')
      .map(tag => tag[1]);

    diagLog('lists', 'decryptPrivateFollows: SUCCESS', { decryptedCount: pubkeys.length, totalTags: privateTags.length });
    return pubkeys;
  } catch (error) {
    diagLog('lists', 'decryptPrivateFollows: UNEXPECTED ERROR — private follows LOST', { error: String(error) });
    return [];
  }
}
