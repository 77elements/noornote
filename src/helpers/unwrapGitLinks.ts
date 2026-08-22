/**
 * Unwrap NIP-34 Git URLs (gitworkshop.dev) to raw nostr: references so the
 * referenced patch / PR / issue / repo renders inline as a card instead of
 * a raw link.
 *
 * Scoped to a known-host whitelist on purpose. Add a new host to GIT_HOSTS
 * when another Nostr-Git frontend ships.
 */

const GIT_HOSTS = ['gitworkshop.dev'];

const GIT_URL_REGEX = new RegExp(
  `https?://(?:${GIT_HOSTS.join('|').replace(/\./g, '\\.')})/\\S*?((?:nevent1|naddr1|note1)[02-9ac-hj-np-z]+)(?=[^02-9ac-hj-np-z]|$)`,
  'gi'
);

export function unwrapGitLinks(text: string): string {
  return text.replace(GIT_URL_REGEX, (_match, ref) => `nostr:${ref}`);
}
