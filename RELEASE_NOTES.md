# NoorNote v0.8.7

## Quoted Notes & Embeds

- Image and video clicks now always work in quoted reposts and nested embeds. Click any image to open the lightbox, click any video to play, no matter how deeply nested.
- Articles that quote the same `nostr:nevent…` more than once now render every occurrence correctly.

## Articles

- Long-form articles now also accept `nostr:<hex-event-id>` as a quote source, in addition to `nevent` / `note` / `naddr`.
- Quotes that sit on their own line render correctly inside the article body, and the Edit Preview tab now matches the final published view (npub mentions, hover cards, Show More).

## Direct Messages

- NIP-17 DMs now send roughly twice as fast and re-open busy conversations without the burst-load stutter.

## Live Streams

- You can now post chat messages directly into a live stream from NoorNote (NIP-53 kind 1311).

## Media

- New accounts now default to `nostr.build` as their media server (25 MiB free tier). Existing accounts keep their current setting.
