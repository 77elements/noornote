import type { NostrEvent } from '@nostr-dev-kit/ndk';

// Stream provider pubkeys that sign kind 30311 events on behalf of streamers.
// For these, the actual streamer is in a `p` tag with role "host"; routing
// zaps to event.pubkey would send them to the service instead of the creator.
const STREAM_PROVIDER_PUBKEYS = new Set([
  'cf45a6ba1363ad7ed213a078e710d24115ae721c9b47bd1ebf4458eaefb4c2a5',
  '81ee947168db2f909895dbd4f71534f4040035575f58156e9a3802d1dd467e1d',
  'f6a25b87f7e7bec9a691e37851b1b57a7b49fa00bb431280303002a3ebca4891',
  '85df822a86599ffbe8143db1e1e1bf2d162fa60fc685c65515963e67cfd7499f',
]);

/**
 * Resolve the zap recipient for a kind 30311 live stream event.
 * If the event author is a known stream provider, returns the pubkey from the
 * `p` tag with role "host". Otherwise returns the event pubkey.
 */
export function getLiveStreamHost(event: NostrEvent): string {
  if (STREAM_PROVIDER_PUBKEYS.has(event.pubkey)) {
    const hostTag = event.tags.find(
      t => t[0] === 'p' && t.length > 3 && t[3]?.toLowerCase() === 'host'
    );
    if (hostTag?.[1]) return hostTag[1];
  }
  return event.pubkey;
}
