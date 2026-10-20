/**
 * ConversationItem — shared DM row core used by MessagesView (conversation
 * list) and GlobalSearchView (local DM search hits). Builds the common
 * skeleton: profile-backed display name + avatar (letter placeholder
 * fallback), header with timestamp, content preview. Callers add their
 * row-level extras (unread badge, delete button, click handlers).
 *
 * Rows reuse the .ui-list / .conversation-item classes from _dm-views.scss.
 */

import { UserProfileService } from '../../services/UserProfileService';
import { formatTimestamp } from '../../helpers/formatTimestamp';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';

export interface ConversationItemData {
  /** Conversation partner pubkey (hex). */
  pubkey: string;
  /** Row preview text (last message or the matched message content). */
  preview: string;
  /** Row timestamp (last message time or the matched message time). */
  timestamp: number;
}

export interface BuiltConversationItem {
  /** Element containing the .conversation-item__user skeleton. */
  element: HTMLElement;
  /** Resolved display name (for confirm dialogs etc.). */
  displayName: string;
}

export async function buildConversationItem(
  data: ConversationItemData
): Promise<BuiltConversationItem> {
  const item = document.createElement('div');
  item.className = 'ui-list__item ui-list__item--clickable conversation-item';
  item.dataset.pubkey = data.pubkey;

  // Fetch profile info (with fallback)
  const fallbackName = `${data.pubkey.slice(0, 8)}...`;
  let displayName = fallbackName;
  let avatarUrl = '';

  try {
    const profile = await UserProfileService.getInstance().getUserProfile(
      data.pubkey
    );
    if (profile) {
      displayName = profile.display_name || profile.name || fallbackName;
      avatarUrl = profile.picture || '';
    }
  } catch (_err) {
    // Use fallback values
  }

  const timeAgo = formatTimestamp(data.timestamp);
  // Avatar: use image if available, otherwise letter placeholder.
  // Wrapped in user-mention for hover card support.
  const avatarHtml = avatarUrl
    ? `<div class="user-mention conversation-item__avatar" data-pubkey="${escapeHtmlAttr(data.pubkey)}"><img class="conversation-item__avatar-img" src="${escapeHtmlAttr(avatarUrl)}" alt="" /></div>`
    : `<div class="user-mention conversation-item__avatar-placeholder" data-pubkey="${escapeHtmlAttr(data.pubkey)}">${escapeHtml(displayName.charAt(0).toUpperCase())}</div>`;

  item.innerHTML = `
    <div class="conversation-item__user">
      ${avatarHtml}
      <div class="conversation-item__content">
        <div class="conversation-item__header">
          <span class="user-mention conversation-item__name" data-pubkey="${escapeHtmlAttr(data.pubkey)}">${escapeHtml(displayName)}</span>
          ${timeAgo}
        </div>
        <div class="conversation-item__preview">
          ${escapeHtml(data.preview)}
        </div>
      </div>
    </div>
  `;

  return { element: item, displayName };
}
