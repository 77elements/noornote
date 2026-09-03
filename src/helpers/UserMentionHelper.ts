/**
 * UserMentionHelper - Unified user mention rendering and interaction handling
 * Provides consistent user display across all components with avatar, username,
 * hover cards, and click navigation to profile.
 */

import { UserHoverCard } from '../components/ui/UserHoverCard';
import { Router } from '../services/Router';
import { encodeNpub } from '../services/NostrToolsAdapter';
import { escapeHtml, escapeHtmlAttr } from './escapeHtml';
import { npubToHex } from './nip19';

export interface UserMentionProfile {
  username: string;
  avatarUrl: string;
}

export interface UserMentionOptions {
  /** Show background with rounded corners (default: true) */
  withBackground?: boolean;
}

/**
 * Render user mention HTML with avatar and username
 * Uses data-profile-pubkey for click handler binding
 *
 * @param pubkey - User's hex pubkey
 * @param profile - Profile data with username and avatarUrl
 * @param options - Rendering options
 * @returns HTML string
 *
 * @example
 * // With background (default) - for Analytics Modal, inline mentions
 * renderUserMention(pubkey, { username: 'alice', avatarUrl: '...' })
 *
 * // Without background - for repost header
 * renderUserMention(pubkey, { username: 'alice', avatarUrl: '...' }, { withBackground: false })
 */
export function renderUserMention(
  pubkey: string,
  profile: UserMentionProfile,
  options: UserMentionOptions = {}
): string {
  const { withBackground = true } = options;
  const bgClass = withBackground ? ' mention-link--bg' : '';

  return `<span class="user-mention" data-pubkey="${pubkey}"><a href="#" class="mention-link${bgClass}" data-profile-pubkey="${pubkey}"><img class="profile-pic profile-pic--mini" src="${escapeHtmlAttr(profile.avatarUrl ?? '')}" alt="" width="18" height="18" loading="lazy" decoding="async" /><span class="mention-name">${escapeHtml(profile.username)}</span></a></span>`;
}

/**
 * Upgrade inline mention links (as produced by npubToUsername html-multi) to the
 * UserMentionHelper wrapper format so hover cards + click nav can bind.
 *
 * Wraps `a[data-mention][href^="/profile/npub1..."]` with
 * `<span class="user-mention" data-pubkey="{hex}">` and adds `data-profile-pubkey`
 * to the anchor. Call setupUserMentionHandlers afterwards.
 */
export function upgradeInlineMentions(container: HTMLElement): void {
  const anchors =
    container.querySelectorAll<HTMLAnchorElement>('a[data-mention]');
  anchors.forEach(anchor => {
    if (anchor.parentElement?.classList.contains('user-mention')) return;

    const href = anchor.getAttribute('href') || '';
    const npub = href.startsWith('/profile/')
      ? href.slice('/profile/'.length)
      : '';
    const hex = npub ? npubToHex(npub) : null;
    if (!hex) return;

    anchor.setAttribute('data-profile-pubkey', hex);

    const wrapper = document.createElement('span');
    wrapper.className = 'user-mention';
    wrapper.setAttribute('data-pubkey', hex);
    anchor.parentNode?.insertBefore(wrapper, anchor);
    wrapper.appendChild(anchor);
  });
}

/**
 * Setup click handlers and hover cards for all user mentions in a container
 * Binds to elements with data-profile-pubkey attribute
 *
 * @param container - DOM element containing user mentions
 *
 * @example
 * const container = document.createElement('div');
 * container.innerHTML = renderUserMention(pubkey, profile);
 * setupUserMentionHandlers(container);
 */
export function setupUserMentionHandlers(container: HTMLElement): void {
  const userHoverCard = UserHoverCard.getInstance();
  const router = Router.getInstance();

  // Find all user mention containers
  const userMentions = container.querySelectorAll('.user-mention');

  userMentions.forEach(mentionEl => {
    const pubkey = (mentionEl as HTMLElement).dataset.pubkey;
    if (!pubkey) return;

    // Setup hover card
    mentionEl.addEventListener('mouseenter', () => {
      userHoverCard.show(pubkey, mentionEl as HTMLElement);
    });

    mentionEl.addEventListener('mouseleave', () => {
      userHoverCard.hide();
    });
  });

  // Setup click navigation for all profile links
  const profileLinks = container.querySelectorAll('[data-profile-pubkey]');

  profileLinks.forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      const profilePubkey = (link as HTMLElement).dataset.profilePubkey;

      if (profilePubkey) {
        try {
          const npub = encodeNpub(profilePubkey);
          router.navigate(`/profile/${npub}`);
        } catch (error) {
          console.error('Failed to encode npub:', error);
        }
      }
    });
  });
}
