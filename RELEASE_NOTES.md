# Release Notes 1.9.3

## New

- **NoorNote speaks German**: switch the entire UI to German in Settings → Interface. English stays the default until you choose — nothing changes on its own.
- **Local full-text search**: search your notes and DMs instantly, entirely on your device. Optional "only local caches" mode in the search spotlight.

## Improved

- Profiles without posts load instantly instead of waiting on relays.

## Fixed in 1.9.3

- Dropdowns, menus and toasts are readable again (transparent-glass regression from 1.9.2).
- Profiles no longer show a false "No events found" while relays are still loading.
- GIF search on desktop.
- Notes with manipulated future timestamps can no longer jump to the top of your feeds.

## Under the hood

- Electron 44 (security backports), Vite 8, faster feed internals — and the groundwork for community translations.
