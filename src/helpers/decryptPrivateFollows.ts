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
export async function decryptPrivateFollows(
  encryptedContent: string,
  authorPubkey: string
): Promise<string[]> {
  if (!encryptedContent || encryptedContent.trim() === '') {
    console.debug('[DIAG:follows] decryptPrivateFollows: empty content, skipping');
    return [];
  }

  console.debug('[DIAG:follows] decryptPrivateFollows: attempting decryption, content length:', encryptedContent.length);

  try {
    const { AuthService } = await import('../services/AuthService');
    const authService = AuthService.getInstance();

    if (authService.isBunkerAuth()) {
      console.debug('[DIAG:follows] decryptPrivateFollows: skipping — bunker auth');
      return [];
    }

    // Auto-detect NIP-04 vs NIP-44 (backward compatibility)
    const isNip04 = encryptedContent.includes('?iv=');
    console.debug('[DIAG:follows] decryptPrivateFollows: detected format:', isNip04 ? 'NIP-04' : 'NIP-44');

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
      console.debug('[DIAG:follows] decryptPrivateFollows: primary decrypt succeeded');
    } catch (primaryError) {
      console.debug('[DIAG:follows] decryptPrivateFollows: primary decrypt failed:', primaryError, ', trying fallback');
      try {
        plaintext = await fallbackDecrypt(encryptedContent, authorPubkey);
        console.debug('[DIAG:follows] decryptPrivateFollows: fallback decrypt succeeded');
      } catch (fallbackError) {
        console.debug('[DIAG:follows] decryptPrivateFollows: BOTH decryption methods FAILED — private follows LOST. Primary:', primaryError, 'Fallback:', fallbackError);
        return [];
      }
    }

    if (!plaintext) {
      console.debug('[DIAG:follows] decryptPrivateFollows: decryption returned empty — private follows LOST');
      return [];
    }

    const privateTags: string[][] = JSON.parse(plaintext);

    if (!Array.isArray(privateTags)) {
      console.debug('[DIAG:follows] decryptPrivateFollows: parsed result is not an array:', typeof privateTags);
      return [];
    }

    const pubkeys = privateTags
      .filter((tag): tag is [string, string, ...string[]] => Array.isArray(tag) && tag[0] === 'p' && typeof tag[1] === 'string')
      .map(tag => tag[1]);

    console.debug('[DIAG:follows] decryptPrivateFollows: SUCCESS — decrypted', pubkeys.length, 'private follows from', privateTags.length, 'tags');
    return pubkeys;
  } catch (error) {
    console.debug('[DIAG:follows] decryptPrivateFollows: UNEXPECTED ERROR — private follows LOST:', error);
    return [];
  }
}
