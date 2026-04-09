# NoorNote v0.8.2

Reliability, architecture and security release on top of 0.8.1.

## Highlights

- **Wallet Balance no longer disappears** after long runtime or account switches. A listener-leak that caused the display under the logo to flicker and vanish over time is fixed, and the wallet now re-initializes cleanly when you switch accounts.
- **NWC connection strings are now encrypted at rest** on every platform (Desktop, Android, Web). AES-256-GCM with a device-bound key. Existing users are migrated silently on first launch — no password, no prompt, no setting, no action required.
- **Rewritten addon system.** Disabled addons now truly stay out of memory (not just hidden from the UI). Eight addons migrated to the new lifecycle, with proper cleanup on toggle-off and account switch.
- **Live Streams (NIP-53)** are now properly documented as supported in the README, along with NIP-94 file metadata events.

## Addon Reliability

- Profile Recognition, Hashtag Subscriptions and Custom Emojis no longer leak state (timers, listeners, cached services) between accounts
- Hashtag Subscriptions polling now stops reliably when you disable the addon
- Live Stream cards now only show a border in the "live" state, and in a subtler color

## Notes

- Copying a note link (nevent) now includes the author's pubkey so recipient clients can resolve it faster
- Fixed a relay rejection when quoting a note by bare `nevent` — empty author pubkeys are no longer emitted into the event

## Under the hood

- New `AddonLoader` architecture with real dynamic-import lazy-loading, serialized init/destroy, and a destroy contract that requires full cleanup. Bookmarks and Tribes are intentionally kept in the existing lists architecture to avoid touching the fragile sync flow.
- New diagnostic logging coverage for NWC migration and addon lifecycle, plus a `diagnose/addons_lifecycle.py` analysis script.
