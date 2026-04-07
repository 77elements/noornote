# NoorNote v0.8.0 — Major Release

**Desktop migrated to Electron, Android app via Capacitor, Custom Emojis addon, complete UI redesign.**

## Highlights

- **Electron Desktop** — replaces Tauri. Faster, leaner, better Linux/macOS support
- **Custom Emojis (NIP-30)** — animated GIFs and image emojis as reactions and in posts. Upload your own pack, browse and import emojis from other users
- **Complete UI Redesign** — pill borders, new section/setting molecules, theme-aware colors, redesigned Settings, Profile, Articles, Lists, DMs, Notifications, Welcome, Onboarding Wizard, and more
- **Addon System Refactor** — each addon now has its own dedicated view, lazy-loaded only when visited
- **Opt-in client tag** — choose whether your posts identify NoorNote as the publishing client
- **Memory usage drastically reduced** — 62% less RAM after long timeline scrolling sessions (3.9 GB → 1.5 GB on Linux). SVG sprite sheet replaces 162 inline icons, LRU caches on stats services, shared IntersectionObserver, leak fixes

## Bug Fixes

- Self-zap button now properly disabled
- Animated GIF emojis render correctly in reactions, notifications, and analytics
- Quoted notes with off-by-one bech32 checksum recoverable
- NIP-88 polls now render in reposts and quoted reposts
- YouTube `m.` and `music.` subdomain URLs no longer leak fragments next to embeds
- Various race conditions in wallet balance, zap button loading, SVG sprite loading
- Capacitor Android: status bar overlap, diagnostic logging, crash logger
