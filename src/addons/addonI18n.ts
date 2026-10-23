/**
 * Addon i18n helper
 * Translates addon registry metadata at render time.
 *
 * ADDON_REGISTRY is a module-level constant, so `_()` must NOT be called
 * there (the i18n catalog loads later in initI18n()). Instead, the literal
 * msgids live in the switch statements below (function scope), which keeps
 * the extractor happy and resolves labels after i18n init.
 */

import { _ } from '../i18n';
import { ADDON_REGISTRY } from './registry';

/** Translate an addon display name (falls back to the registry name). */
export function translateAddonName(id: string): string {
  switch (id) {
    case 'bookmarks':
      return _('Bookmarks');
    case 'tribes':
      return _('Tribes');
    case 'extended-follows':
      return _('Extended Follows');
    case 'wallet-balance':
      return _('Wallet Balance');
    case 'profile-recognition':
      return _('Profile Recognition');
    case 'marketplace':
      return _('Marketplace');
    case 'follow-packs':
      return _('Follow Packs');
    case 'follower-notification':
      return _('Follower Notification');
    case 'hashtag-subscriptions':
      return _('Hashtag Subscriptions');
    case 'list-settings':
      return _('List Sync Mode');
    case 'custom-emojis':
      return _('Custom Emojis');
    case 'wordfilter':
      return _('Word Filter');
    case 'live-streams-player':
      return _('Live Streams Player');
    case 'scheduled-posts':
      return _('Scheduled Posts');
    case 'badges':
      return _('Badges');
    case 'note-taking':
      return _('Note taking');
    case 'bulk-delete':
      return _('Bulk delete');
    case 'nostr-majlis':
      return _('Nostr-Majlis');
    case 'group-chats':
      return _('Group Chats');
    case 'analytics':
      return _('Analytics');
    case 'btc-price':
      return _('BTC Price');
    case 'calendar':
      return _('Calendar');
    default:
      return ADDON_REGISTRY.find(a => a.id === id)?.name ?? id;
  }
}

/** Translate an addon description (falls back to the registry description). */
export function translateAddonDescription(id: string): string {
  switch (id) {
    case 'bookmarks':
      return _(
        'Organize notes, articles and links in bookmark folders — private or public.'
      );
    case 'tribes':
      return _(
        'Subscribe to shared follow lists and follow curated groups in one go.'
      );
    case 'extended-follows':
      return _(
        'Track follows, unfollows and profile changes beyond the plain follow list.'
      );
    case 'wallet-balance':
      return _('Show your NIP-60 Lightning wallet balance in the sidebar.');
    case 'profile-recognition':
      return _('Blink the avatars of profiles you already interacted with.');
    case 'marketplace':
      return _(
        'NIP-99 classified listings — browse, publish and manage your own.'
      );
    case 'follow-packs':
      return _('Browse, create and share curated follow packs.');
    case 'follower-notification':
      return _('Get notified when someone follows or unfollows you.');
    case 'hashtag-subscriptions':
      return _('Periodically fetch new notes for hashtags you follow.');
    case 'list-settings':
      return _(
        'Configure how follows, mutes, bookmarks and tribes sync to relays.'
      );
    case 'custom-emojis':
      return _('Use your own NIP-30 custom emojis in notes and reactions.');
    case 'wordfilter':
      return _('Hide timeline notes containing words on your filter list.');
    case 'live-streams-player':
      return _('Play NIP-53 live streams inline in the timeline.');
    case 'scheduled-posts':
      return _('Schedule notes and articles for later publishing.');
    case 'badges':
      return _('Create badge definitions and award badges to profiles.');
    case 'note-taking':
      return _('Write private, encrypted notes that stay yours alone.');
    case 'bulk-delete':
      return _('Delete many of your notes at once via NIP-09 requests.');
    case 'nostr-majlis':
      return _('Prayer times, dhikr and holiday reminders.');
    case 'group-chats':
      return _('Chat in invite-only groups and follow Armada communities.');
    case 'analytics':
      return _('Local usage analytics that never leave this device.');
    case 'btc-price':
      return _('Show the current Bitcoin price in the sidebar.');
    case 'calendar':
      return _(
        'NIP-52 calendar events with RSVPs, reminders and private events.'
      );
    default:
      return ADDON_REGISTRY.find(a => a.id === id)?.description ?? '';
  }
}
