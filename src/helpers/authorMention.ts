/**
 * Shared author-mention renderer for compact feed cards (ArticleTimeline scc
 * variant, SccRecipeFeed, …): async profile lookup → mini-avatar + username
 * line, then wire hover-card handlers.
 *
 * Test-only note: callers own the container element; this helper only fills
 * the `.author` slot inside it.
 */

import { hexToNpub } from './nip19';
import { escapeHtml, escapeHtmlAttr } from './escapeHtml';
import { setupUserMentionHandlers } from './UserMentionHelper';
import { UserProfileService } from '../services/UserProfileService';

export async function loadAuthorMention(
  card: HTMLElement,
  pubkey: string
): Promise<void> {
  const authorEl = card.querySelector('.author');
  if (!authorEl) return;

  const npub = hexToNpub(pubkey) || pubkey;
  try {
    const profile =
      await UserProfileService.getInstance().getUserProfile(pubkey);
    const username =
      profile?.name || profile?.display_name || `${npub.slice(0, 12)}...`;
    const picture = profile?.picture || '';

    authorEl.innerHTML = `
      <a href="/profile/${npub}" class="mention-link" data-profile-pubkey="${pubkey}">
        <img class="profile-pic profile-pic--mini" src="${escapeHtmlAttr(picture)}" alt="" width="18" height="18" loading="lazy" decoding="async" />${escapeHtml(username)}</a>
    `;
  } catch {
    authorEl.innerHTML = `
      <a href="/profile/${npub}" class="mention-link" data-profile-pubkey="${pubkey}">
        <img class="profile-pic profile-pic--mini" src="" alt="" width="18" height="18" loading="lazy" decoding="async" />${npub.slice(0, 12)}...</a>
    `;
  }

  setupUserMentionHandlers(authorEl as HTMLElement);
}
