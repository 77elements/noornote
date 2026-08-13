/**
 * Addon Registry
 *
 * Single source of truth for the list of addons. Used by:
 *   - MainLayout sidebar (renders the Addons sub-nav)
 *   - App.ts route registration
 *   - Any component that needs to enumerate addons
 *
 * Each addon has its own dedicated View under `src/addons/<id>/<Name>AddonView.ts`,
 * lazy-loaded via ViewMountingService when its route is visited.
 */

export interface AddonRegistryEntry {
  /** Stable id, also used as the URL slug */
  id: string;
  /** Display name shown in the sub-nav */
  name: string;
  /** Full route path */
  route: string;
  /** ViewMountingService factory id */
  viewId: string;
}

export const ADDON_REGISTRY: AddonRegistryEntry[] = [
  { id: 'bookmarks',             name: 'Bookmarks',              route: '/addons/bookmarks',             viewId: 'addon-bookmarks' },
  { id: 'tribes',                name: 'Tribes',                 route: '/addons/tribes',                viewId: 'addon-tribes' },
  { id: 'extended-follows',      name: 'Extended Follows',       route: '/addons/extended-follows',      viewId: 'addon-extended-follows' },
  { id: 'wallet-balance',        name: 'Wallet Balance',         route: '/addons/wallet-balance',        viewId: 'addon-wallet-balance' },
  { id: 'profile-recognition',   name: 'Profile Recognition',    route: '/addons/profile-recognition',   viewId: 'addon-profile-recognition' },
  { id: 'marketplace',           name: 'Marketplace',            route: '/addons/marketplace',           viewId: 'addon-marketplace' },
  { id: 'follow-packs',          name: 'Follow Packs',           route: '/addons/follow-packs',          viewId: 'addon-follow-packs' },
  { id: 'follower-notification', name: 'Follower Notification',   route: '/addons/follower-notification', viewId: 'addon-follower-notification' },
  { id: 'hashtag-subscriptions', name: 'Hashtag Subscriptions',  route: '/addons/hashtag-subscriptions', viewId: 'addon-hashtag-subscriptions' },
  { id: 'list-settings',         name: 'List Sync Mode',         route: '/addons/list-settings',         viewId: 'addon-list-settings' },
  { id: 'custom-emojis',         name: 'Custom Emojis',          route: '/addons/custom-emojis',         viewId: 'addon-custom-emojis' },
  { id: 'wordfilter',            name: 'Word Filter',            route: '/addons/wordfilter',            viewId: 'addon-wordfilter' },
  { id: 'live-streams-player',   name: 'Live Streams Player',    route: '/addons/live-streams-player',   viewId: 'addon-live-streams-player' },
  { id: 'scheduled-posts',       name: 'Scheduled Posts',        route: '/addons/scheduled-posts',       viewId: 'addon-scheduled-posts' },
  { id: 'badges',                name: 'Badges',                 route: '/addons/badges',                viewId: 'addon-badges' },
  { id: 'note-taking',           name: 'Note taking',            route: '/addons/note-taking',           viewId: 'addon-note-taking' },
  { id: 'bulk-delete',           name: 'Bulk delete',            route: '/addons/bulk-delete',           viewId: 'addon-bulk-delete' },
  { id: 'nostr-majlis',          name: 'Nostr-Majlis',           route: '/addons/nostr-majlis',          viewId: 'addon-nostr-majlis' },
  { id: 'group-chats',              name: 'Group Chats',             route: '/addons/group-chats',           viewId: 'addon-group-chats' },
];
