/**
 * Convert npub to username
 * Can return plain string OR HTML with links
 */

import { UserProfileService } from '../services/UserProfileService';
import { npubToHex, nprofileToNpub } from './nip19';
import { escapeHtml } from './escapeHtml';

export interface Profile {
  name?: string;
  display_name?: string;
  picture?: string;
}

export type ProfileResolver = (hexPubkey: string) => Profile | null;

/**
 * MODE 1 (Simple): npub → username string
 * MODE 2 (HTML Single): npub → <a>@username</a>
 * MODE 3 (HTML Multi): HTML text with multiple mentions → all replaced
 */
export function npubToUsername(npub: string): string;
export function npubToUsername(npub: string, mode: 'html-single', profileResolver: ProfileResolver): string;
export function npubToUsername(htmlText: string, mode: 'html-multi', profileResolver: ProfileResolver): string;
export function npubToUsername(
  input: string,
  mode?: 'html-single' | 'html-multi' | ProfileResolver,
  profileResolver?: ProfileResolver
): string {
  // Legacy compatibility: detect old signature (second param is ProfileResolver)
  if (typeof mode === 'function') {
    return npubToUsernameHTMLMulti(input, mode as ProfileResolver);
  }

  // Simple mode (default): single npub to username string
  if (!mode) {
    return npubToUsernameSimple(input);
  }

  // HTML Single mode: single npub to HTML link
  if (mode === 'html-single' && profileResolver) {
    return npubToUsernameHTMLSingle(input, profileResolver);
  }

  // HTML Multi mode: process entire HTML text with multiple mentions
  if (mode === 'html-multi' && profileResolver) {
    return npubToUsernameHTMLMulti(input, profileResolver);
  }

  return input;
}

/**
 * Simple mode: npub → username (no HTML)
 * Returns display name from cache, or FULL npub as fallback
 */
function npubToUsernameSimple(npub: string): string {
  try {
    const hexPubkey = npubToHex(npub);

    // Try to get cached username (synchronous)
    const userProfileService = UserProfileService.getInstance();
    const cachedUsername = userProfileService.getUsername(hexPubkey);

    // If we got a real name (not hex/npub fallback), use it
    // Check if it's NOT the hex pubkey (fallback)
    if (cachedUsername && cachedUsername !== hexPubkey) {
      return cachedUsername;
    }

    // Trigger async profile fetch (fire and forget)
    userProfileService.getUserProfile(hexPubkey).catch((_error) => {
      // Ignore errors, profile will stay as fallback
    });

    // Fallback to FULL npub (NO SHORTENING!)
    return npub;
  } catch {
    return npub;
  }
}

/**
 * HTML mode: single npub → HTML link with username
 */
function npubToUsernameHTMLSingle(npub: string, profileResolver: ProfileResolver): string {
  try {
    const hexPubkey = npubToHex(npub);
    const profile = profileResolver(hexPubkey);
    const username = profile?.display_name || profile?.name || npub;
    const escapedUsername = escapeHtml(username);
    const picture = profile?.picture || '';
    const escapedPicture = picture ? escapeHtmlAttribute(picture) : '';
    return `<a href="/profile/${npub}" class="mention-link mention-link--bg"><img class="profile-pic profile-pic--mini" src="${escapedPicture}" alt="" />${escapedUsername}</a>`;
  } catch {
    return npub;
  }
}

/**
 * Escape text for safe use in HTML attributes
 * Escapes quotes to prevent attribute injection
 */
function escapeHtmlAttribute(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Build mention HTML with profile picture
 */
function buildMentionHTML(npub: string, username: string, picture?: string, isLoading = false): string {
  const avatarSrc = picture ? escapeHtmlAttribute(picture) : '';
  const escapedUsername = escapeHtml(username);
  const attrs = isLoading ? 'data-mention data-loading' : 'data-mention';
  return `<a href="/profile/${npub}" ${attrs} class="mention-link mention-link--bg"><img class="profile-pic profile-pic--mini" src="${avatarSrc}" alt="" />${escapedUsername}</a>`;
}

/**
 * HTML Multi mode: HTML text with multiple npub/nprofile mentions
 */
function npubToUsernameHTMLMulti(
  htmlText: string,
  profileResolver: ProfileResolver
): string {
  let text = htmlText;

  // Step 1: Handle nprofile (with or without nostr: prefix)
  // Use capturing groups to get full match
  // Valid nprofile format: nprofile1 + bech32 chars (excludes b, i, o)
  // Variable length due to relay hints, but must be at least 59 chars
  // Use word boundary (\b) or lookahead to prevent over-matching
  text = text.replace(/(nostr:)?(nprofile1[023456789acdefghjklmnpqrstuvwxyz]{58,})(?=[^023456789acdefghjklmnpqrstuvwxyz]|$)/gi, (fullMatch, _prefix, nprofile) => {
    try {
      const npub = nprofileToNpub(nprofile);
      const hexPubkey = npubToHex(npub);
      const profile = profileResolver(hexPubkey);

      if (profile?.name || profile?.display_name) {
        const username = profile.name || profile.display_name;
        return buildMentionHTML(npub, username!, profile.picture);
      } else {
        // Fallback: show loading placeholder until profile loads
        return buildMentionHTML(npub, '...', undefined, true);
      }
    } catch (_error) {
      // Fail gracefully - return original text without logging
      // (invalid checksums are common in wild, not worth spamming console)
      return fullMatch;
    }
  });

  // Step 2: Handle npub (with or without nostr: prefix)
  // BUT skip npubs that are already inside links we created above
  // Valid npub format: npub1 + 58 bech32 chars (excludes b, i, o) = exactly 63 chars
  // Use lookahead to ensure we stop at word boundary
  text = text.replace(/(nostr:)?(npub1[023456789acdefghjklmnpqrstuvwxyz]{58})(?=[^023456789acdefghjklmnpqrstuvwxyz]|$)/gi, (fullMatch, _prefix, npub, offset, string) => {

    // Check if this npub is inside a link we already created
    const before = string.substring(Math.max(0, offset - 60), offset);

    // Skip if it's inside href="/profile/..." or has data-mention marker
    if (before.includes('href="/profile/') || before.includes('data-mention')) {
      return fullMatch;
    }

    try {
      const hexPubkey = npubToHex(npub);
      const profile = profileResolver(hexPubkey);

      if (profile?.name || profile?.display_name) {
        const username = profile.name || profile.display_name;
        return buildMentionHTML(npub, username!, profile.picture);
      } else {
        // Fallback: show loading placeholder until profile loads
        return buildMentionHTML(npub, '...', undefined, true);
      }
    } catch (_error) {
      // Fail gracefully - return original text without logging
      return fullMatch;
    }
  });

  return text;
}
