/**
 * Addon Registry
 *
 * Single source of truth for the list of addons. Used by:
 *   - The /addons overview page (tiles: name + description + enabled LED)
 *   - App.ts route registration
 *   - Any component that needs to enumerate addons
 *
 * Each addon has its own dedicated View under `src/addons/<id>/<Name>AddonView.ts`,
 * lazy-loaded via ViewMountingService when its route is visited.
 *
 * `status` drives the overview-page badge next to the LED ('new' | 'updated').
 * Maintained BY HAND during sessions — the convention: the most recently
 * added addon carries 'new'. As soon as work happens on ANY other addon, the
 * status moves: a freshly built addon takes 'new', a changed/extended
 * existing one takes 'updated' (and the previous holder is stripped).
 */

export interface AddonRegistryEntry {
  /** Stable id, also used as the URL slug */
  id: string;
  /** Display name shown on the overview tile */
  name: string;
  /** Full route path */
  route: string;
  /** ViewMountingService factory id */
  viewId: string;
  /** One-line description shown on the /addons overview tile */
  description: string;
  /**
   * Overview badge: 'new' = most recently added addon, 'updated' = recently
   * changed/extended. At most ONE addon carries a status at a time — see the
   * convention in the file header.
   */
  status?: 'new' | 'updated';
}

export const ADDON_REGISTRY: AddonRegistryEntry[] = [
  {
    id: 'bookmarks',
    name: 'Bookmarks',
    route: '/addons/bookmarks',
    viewId: 'addon-bookmarks',
    description:
      'Organize notes, articles and links in bookmark folders — private or public.',
  },
  {
    id: 'tribes',
    name: 'Tribes',
    route: '/addons/tribes',
    viewId: 'addon-tribes',
    description:
      'Subscribe to shared follow lists and follow curated groups in one go.',
  },
  {
    id: 'extended-follows',
    name: 'Extended Follows',
    route: '/addons/extended-follows',
    viewId: 'addon-extended-follows',
    description:
      'Track follows, unfollows and profile changes beyond the plain follow list.',
  },
  {
    id: 'wallet-balance',
    name: 'Wallet Balance',
    route: '/addons/wallet-balance',
    viewId: 'addon-wallet-balance',
    description: 'Show your NIP-60 Lightning wallet balance in the sidebar.',
  },
  {
    id: 'profile-recognition',
    name: 'Profile Recognition',
    route: '/addons/profile-recognition',
    viewId: 'addon-profile-recognition',
    description: 'Blink the avatars of profiles you already interacted with.',
  },
  {
    id: 'marketplace',
    name: 'Marketplace',
    route: '/addons/marketplace',
    viewId: 'addon-marketplace',
    description:
      'NIP-99 classified listings — browse, publish and manage your own.',
  },
  {
    id: 'follow-packs',
    name: 'Follow Packs',
    route: '/addons/follow-packs',
    viewId: 'addon-follow-packs',
    description: 'Browse, create and share curated follow packs.',
  },
  {
    id: 'follower-notification',
    name: 'Follower Notification',
    route: '/addons/follower-notification',
    viewId: 'addon-follower-notification',
    description: 'Get notified when someone follows or unfollows you.',
  },
  {
    id: 'hashtag-subscriptions',
    name: 'Hashtag Subscriptions',
    route: '/addons/hashtag-subscriptions',
    viewId: 'addon-hashtag-subscriptions',
    description: 'Periodically fetch new notes for hashtags you follow.',
  },
  {
    id: 'list-settings',
    name: 'List Sync Mode',
    route: '/addons/list-settings',
    viewId: 'addon-list-settings',
    description:
      'Configure how follows, mutes, bookmarks and tribes sync to relays.',
  },
  {
    id: 'custom-emojis',
    name: 'Custom Emojis',
    route: '/addons/custom-emojis',
    viewId: 'addon-custom-emojis',
    description: 'Use your own NIP-30 custom emojis in notes and reactions.',
  },
  {
    id: 'wordfilter',
    name: 'Word Filter',
    route: '/addons/wordfilter',
    viewId: 'addon-wordfilter',
    description: 'Hide timeline notes containing words on your filter list.',
  },
  {
    id: 'live-streams-player',
    name: 'Live Streams Player',
    route: '/addons/live-streams-player',
    viewId: 'addon-live-streams-player',
    description: 'Play NIP-53 live streams inline in the timeline.',
  },
  {
    id: 'scheduled-posts',
    name: 'Scheduled Posts',
    route: '/addons/scheduled-posts',
    viewId: 'addon-scheduled-posts',
    description: 'Schedule notes and articles for later publishing.',
  },
  {
    id: 'badges',
    name: 'Badges',
    route: '/addons/badges',
    viewId: 'addon-badges',
    description: 'Create badge definitions and award badges to profiles.',
  },
  {
    id: 'note-taking',
    name: 'Note taking',
    route: '/addons/note-taking',
    viewId: 'addon-note-taking',
    description: 'Write private, encrypted notes that stay yours alone.',
  },
  {
    id: 'bulk-delete',
    name: 'Bulk delete',
    route: '/addons/bulk-delete',
    viewId: 'addon-bulk-delete',
    description: 'Delete many of your notes at once via NIP-09 requests.',
  },
  {
    id: 'nostr-majlis',
    name: 'Nostr-Majlis',
    route: '/addons/nostr-majlis',
    viewId: 'addon-nostr-majlis',
    description: 'Prayer times, dhikr and holiday reminders.',
  },
  {
    id: 'group-chats',
    name: 'Group Chats',
    route: '/addons/group-chats',
    viewId: 'addon-group-chats',
    description: 'Chat in invite-only groups and follow Armada communities.',
  },
  {
    id: 'analytics',
    name: 'Analytics',
    route: '/addons/analytics',
    viewId: 'addon-analytics',
    description: 'Local usage analytics that never leave this device.',
  },
  {
    id: 'btc-price',
    name: 'BTC Price',
    route: '/addons/btc-price',
    viewId: 'addon-btc-price',
    description: 'Show the current Bitcoin price in the sidebar.',
  },
  {
    id: 'calendar',
    name: 'Calendar',
    route: '/addons/calendar',
    viewId: 'addon-calendar',
    description:
      'NIP-52 calendar events with RSVPs, reminders and private events.',
    status: 'new',
  },
];
