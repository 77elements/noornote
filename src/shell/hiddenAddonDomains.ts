/**
 * Focus addon-domain id map (v2, hidden objects) — PURE leaf module, no
 * imports. The domain → addon registry id pairs (only where they differ
 * from the domain id do they carry information; the full map keeps the
 * load-guard and the shutdown code in lockstep):
 *
 * - DevLoadExpectations.resolveExpectationsForHiddenState (load guard,
 *   dev-only, node env): budgets reduce per hidden addon domain — it must
 *   NOT import the setter map (domainShutdown.ts pulls 17 addon index
 *   files → classic components → src/lists, which breaks the node test
 *   env).
 * - domainShutdown.ts (browser): the same keys with the setter functions.
 *   focusDomainShutdown.test.ts asserts both maps agree.
 *
 * List-backed domains (muted, bookmarks, tribes) are absent — no addon
 * toggle (docs/features/lists.md field test).
 */
export const HIDDEN_ADDON_DOMAINS: Readonly<Record<string, string>> =
  Object.freeze({
    analytics: 'analytics',
    badges: 'badges',
    'bulk-delete': 'bulk-delete',
    calendar: 'calendar',
    'word-filter': 'wordfilter',
    'custom-emojis': 'custom-emojis',
    'feedback-board': 'feedback-board',
    'follow-packs': 'follow-packs',
    'follower-notification': 'follower-notification',
    'group-chats': 'group-chats',
    'hashtag-subscriptions': 'hashtag-subscriptions',
    'live-streams': 'live-streams',
    marketplace: 'marketplace',
    majlis: 'nostr-majlis',
    'note-taking': 'note-taking',
    'scheduled-posts': 'scheduled-posts',
    'wallet-balance': 'wallet-balance',
    'btc-price': 'btc-price',
  });
