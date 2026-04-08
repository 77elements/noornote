# NoorNote v0.8.1

Bugfixes and small features on top of 0.8.0.

## Highlights

- **Article Editor — Focus Mode** — fullscreen distraction-free writing with title, content and Markdown toolbar. Esc to exit
- **Backdate articles** — new "Published at" picker lets you set an older date when re-publishing older articles to Nostr. The article view shows the original publish date prominently and the last-edit date in small print below
- **Inline Lightning invoices (BOLT11)** — Pay button directly inside notes, quotes and DMs via WebLN or NWC
- **Live Streams (NIP-53)** — new experimental Live Streams Player addon with inline hls.js playback, plus rendering of live stream cards from `naddr` references

## Privacy

- YouTube tracking parameters (`pp`, `si`, `ab_channel`, `utm_*`, `gclid`, `fbclid`, …) are stripped from your notes and replies at publish time. The Post and Reply preview tabs reflect exactly what gets published

## Bug Fixes

- Marketplace, Follow Packs and Word Filter addons no longer show their content when the addon is disabled
- Article editor header uses the standard layout (heading left, Back button right)
- YouTube embed URLs no longer leak `&t=…&pp=…` fragments next to the video
