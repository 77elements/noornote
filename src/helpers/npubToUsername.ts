/**
 * Convert npub to username
 * Can return plain string OR HTML with links
 */

import { UserProfileService } from '../services/UserProfileService';
import { npubToHex, nprofileToNpub } from './nip19';
import { escapeHtml, escapeHtmlAttr } from './escapeHtml';
import { getAvatarFallback } from './avatarFallback';
import { getPetname as getPetnameSync } from './petnames';

export interface Profile {
  name?: string;
  display_name?: string;
  picture?: string;
}

export type ProfileResolver = (hexPubkey: string) => Profile | null;

export interface NpubToUsernameOptions {
  forceFullMode?: boolean;
}

// Threshold for switching to simple mention mode (no profile pics)
const SIMPLE_MENTION_THRESHOLD = 20;

const BECH32_CHARS = '023456789acdefghjklmnpqrstuvwxyz';
const NPROFILE_REGEX = new RegExp(`(nostr:)?(nprofile1[${BECH32_CHARS}]{58,})(?=[^${BECH32_CHARS}]|$)`, 'gi');
const NPUB_REGEX = new RegExp(`(nostr:)?(npub1[${BECH32_CHARS}]{58})(?=[^${BECH32_CHARS}]|$)`, 'gi');

/**
 * MODE 1 (Simple): npub → username string
 * MODE 2 (HTML Single): npub → <a>@username</a>
 * MODE 3 (HTML Multi): HTML text with multiple mentions → all replaced
 */
export function npubToUsername(npub: string): string;
export function npubToUsername(npub: string, mode: 'html-single', profileResolver: ProfileResolver): string;
export function npubToUsername(htmlText: string, mode: 'html-multi', profileResolver: ProfileResolver, options?: NpubToUsernameOptions): string;
export function npubToUsername(
  input: string,
  mode?: 'html-single' | 'html-multi' | ProfileResolver,
  profileResolver?: ProfileResolver,
  options?: NpubToUsernameOptions
): string {
  // Legacy compatibility: detect old signature (second param is ProfileResolver)
  if (typeof mode === 'function') {
    return npubToUsernameHTMLMulti(input, mode as ProfileResolver);
  }

  if (!mode) {
    return npubToUsernameSimple(input);
  }

  if (mode === 'html-single' && profileResolver) {
    return npubToUsernameHTMLSingle(input, profileResolver);
  }

  if (mode === 'html-multi' && profileResolver) {
    return npubToUsernameHTMLMulti(input, profileResolver, options);
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
    if (!hexPubkey) return npub;

    const userProfileService = UserProfileService.getInstance();
    const cachedUsername = userProfileService.getUsername(hexPubkey);

    if (cachedUsername && cachedUsername !== hexPubkey) {
      return cachedUsername;
    }

    // Fire-and-forget: trigger async profile fetch for future resolution
    userProfileService.getUserProfile(hexPubkey).catch(() => {});

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
    if (!hexPubkey) return npub;
    const profile = profileResolver(hexPubkey);
    const username = profile?.display_name || profile?.name || npub;
    const escapedUsername = escapeHtml(username);
    const picture = profile?.picture || getAvatarFallback(hexPubkey);
    const escapedPicture = escapeHtmlAttr(picture);
    const petname = getPetnameSync(hexPubkey);
    const petnameSuffix = petname ? ` <span class="mention-petname">(${escapeHtml(petname)})</span>` : '';
    return `<a href="/profile/${npub}" class="mention-link mention-link--bg"><img class="profile-pic profile-pic--mini" src="${escapedPicture}" data-pubkey="${hexPubkey}" alt="" />${escapedUsername}${petnameSuffix}</a>`;
  } catch {
    return npub;
  }
}


/**
 * Build mention HTML with profile picture (full mode)
 */
function buildMentionHTML(npub: string, username: string, picture?: string, isLoading = false, hexPubkey?: string): string {
  const fallback = hexPubkey ? getAvatarFallback(hexPubkey) : '';
  const avatarSrc = escapeHtmlAttr(picture || fallback);
  const pubkeyAttr = hexPubkey ? `data-pubkey="${hexPubkey}"` : '';
  const escapedUsername = escapeHtml(username);
  const attrs = isLoading ? 'data-mention data-loading' : 'data-mention';
  return `<a href="/profile/${npub}" ${attrs} class="mention-link mention-link--bg"><img class="profile-pic profile-pic--mini" src="${avatarSrc}" ${pubkeyAttr} alt="" />${escapedUsername}</a>`;
}

/**
 * Build simple mention HTML without profile picture (for threads with many mentions)
 */
function buildSimpleMentionHTML(npub: string, username: string, isLoading = false): string {
  const escapedUsername = escapeHtml(username);
  const attrs = isLoading ? 'data-mention data-loading' : 'data-mention';
  return `<a href="/profile/${npub}" ${attrs} class="mention-link">@${escapedUsername}</a>`;
}

/**
 * Count mentions in text (npub + nprofile)
 */
function countMentions(text: string): number {
  const nprofileMatches = text.match(NPROFILE_REGEX) || [];
  const npubMatches = text.match(NPUB_REGEX) || [];
  return nprofileMatches.length + npubMatches.length;
}

/**
 * Check if a match position is inside an HTML tag or an already-created mention link.
 * Prevents double-processing of npubs that appear in href attributes or tag content.
 */
function isInsideExistingHTML(text: string, offset: number): boolean {
  // Check if inside an unclosed HTML tag (e.g. npub inside src="...npub1...blossom.band/...")
  const beforeTag = text.substring(Math.max(0, offset - 500), offset);
  const lastOpen = beforeTag.lastIndexOf('<');
  const lastClose = beforeTag.lastIndexOf('>');
  if (lastOpen > lastClose) return true;

  // Check if inside an already-created mention link from step 1
  const nearContext = text.substring(Math.max(0, offset - 60), offset);
  if (nearContext.includes('href="/profile/') || nearContext.includes('data-mention')) return true;

  return false;
}

/**
 * Resolve a profile to mention HTML, with loading placeholder fallback.
 */
function resolveProfileToMentionHTML(
  npub: string,
  profile: Profile | null,
  useSimpleMode: boolean,
  hexPubkey?: string
): string {
  if (profile?.name || profile?.display_name) {
    const username = (profile.name || profile.display_name)!;
    return useSimpleMode
      ? buildSimpleMentionHTML(npub, username)
      : buildMentionHTML(npub, username, profile.picture, false, hexPubkey);
  }

  // Loading placeholder, updated later by ContentProcessor.updateMentionsInDOM
  return useSimpleMode
    ? buildSimpleMentionHTML(npub, '...', true)
    : buildMentionHTML(npub, '...', undefined, true, hexPubkey);
}

/**
 * HTML Multi mode: replace all npub/nprofile mentions in HTML text
 */
function npubToUsernameHTMLMulti(
  htmlText: string,
  profileResolver: ProfileResolver,
  options?: NpubToUsernameOptions
): string {
  let text = htmlText;

  const mentionCount = countMentions(text);
  const useSimpleMode = options?.forceFullMode ? false : mentionCount > SIMPLE_MENTION_THRESHOLD;

  // Step 1: Replace nprofile mentions
  text = text.replace(NPROFILE_REGEX, (fullMatch, _prefix, nprofile) => {
    try {
      const npub = nprofileToNpub(nprofile);
      const hexPubkey = npubToHex(npub);
      if (!hexPubkey) return fullMatch;
      return resolveProfileToMentionHTML(npub, profileResolver(hexPubkey), useSimpleMode, hexPubkey);
    } catch {
      return fullMatch;
    }
  });

  // Step 2: Replace npub mentions, skipping those already inside HTML from step 1
  text = text.replace(NPUB_REGEX, (fullMatch, _prefix, npub, offset, string) => {
    if (isInsideExistingHTML(string, offset)) return fullMatch;

    try {
      const hexPubkey = npubToHex(npub);
      if (!hexPubkey) return fullMatch;
      return resolveProfileToMentionHTML(npub, profileResolver(hexPubkey), useSimpleMode, hexPubkey);
    } catch {
      return fullMatch;
    }
  });

  return text;
}
