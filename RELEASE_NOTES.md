# NoorNote 0.9.5

**NosPress** — New Flip-card block (front/back faces, 3D rotate or fade, hover/click trigger). New Sticky-block state panel with transitions. New Danger Zone (Delete from Relays / Local / Both) in the Global tab. Public URLs at `noornote.app/<your-handle>/` are now opt-in via the addon toggle — turning the addon off removes the public space cleanly. Save / Publish / Discard moved into the editor header; Reset-to-Global migrated into per-page tiles.

**Silent Zaps** — Send anonymous zaps signed with a throwaway ephemeral key; your npub never appears on the request and recipients see "Someone silently zapped".

**Mute filter** — Centralized last-line-of-defense filter so nothing from a muted user (including transitive reposts) leaks across any timeline, thread, profile, notification, or quote.

**Search** — Spotlight now recognises `nostr:` URIs, `nprofile1` / `note1` / `naddr1` identifiers, and NIP-05 handles like `alice@example.com` — paste and jump straight to the right view.

**Reliability** — Quote and repost cross-relay fetches now find events much more often (parent-author outbound fallback, e-tag relay hints, cached NIP-65 outbox in IndexedDB). DM sends reach recipients whose inbox-list isn't on our read set.
