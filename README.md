# NoorNote

**NoorNote** (Arabic: نور, meaning "light") — a client for [Nostr](https://nostr.com), the decentralized social protocol.

<!-- desc-sync:intro -->
A slim yet feature rich Nostr client that doesn't rely on any Google services, under an open source license.

It focuses not just on the social media side but also heavily on the other stuff aspect of Nostr. Things like marketplace products, Zap Streams, tribes, drag and drop bookmark lists with folders, follow packs, custom emojis, an onboarding wizard, plus tons of other Nostr services and innovative features you won't find in other clients are all built in as addons. Great for Nostr newbies as well as advanced users.

**Available as [Web App](https://noornote.app), [Desktop App (Linux & macOS)](https://noornote.app/download/) and Android App (on [Zapstore](https://zapstore.dev)).** Windows is not officially supported.
<!-- /desc-sync:intro -->

## Features

### Core
- **Timeline** - Follow your network, see latest posts, reposts, and quotes
- **Notifications** - Likes, zaps, reposts, mentions, and replies
- **Direct Messages** - Encrypted private conversations (NIP-17 + legacy NIP-04)
- **Long-Form Articles** - Read and write NIP-23 articles with dedicated timeline
- **Picture Posts** - NIP-68 kind:20 image-first posts with multi-image grids
- **Polls** - Create and vote on NIP-88 polls
- **Zaps** - Send and receive Lightning payments via NWC
- **Comments** - NIP-22 Kind:1111 universal comments with Reply/Comment switch
- **Custom Emojis (display)** - Render NIP-30 custom emojis (incl. animated GIFs) from any author

### Highlights
- **Beginner-friendly onboarding** - Step-by-step profile setup with guided explanations, first follows via [calle's Follow Packs](https://github.com/callebtc/following.space), and Lightning wallet setup with [Rizful](https://rizful.com)
- **Spotlight-like search** - Search by Event, Username, npub and full-text. With built-in browsing history. Quick access to anything with CMD+K/CTRL+K
- **Search in npub** - Search for keywords within a specific user's posts
- **Custom Bookmarks** - Bookmark any URL, just like in a browser
- **Mute Threads** - Say bye to hell threads
- **Follow lists** - With mutual badges
- **Quoted reposts** - Shown in note's replies
- **Article notifications** - Get notified on new articles per user
- **Analytics per note** - See who liked, reposted, quoted, replied, or zapped
- **Thread mention alerts** - Get notified when someone replies to a note you were mentioned in
- **Local list backups** - Never lose your follows, bookmarks, or mutes again
- **Multiple NIP-05 support** - Add multiple verified addresses to your profile
- **Image reposts** - Share images with automatic source attribution
- **Notification priorities** - Drag & drop to customize notification order
- **Rich DM content** - Links, media, mentions, and quoted notes in direct messages
- **7 color themes** - Deep Purple, Bright Superman, Code Bunker, Soft Lilac, Dark Symbiote, Neon Harley, Wake up Neo
- **Font size controls** - Adjustable text size with persistent preference
- **Layout modes** - Phone mode and customizable layout options
- **Mutual change alerts** - Get notified when someone stops following back
- **Hijri calendar** - Islamic date display alongside Gregorian dates
- **Relay browsing** - Filter timeline to show content from specific relays
- **Time Machine** - Jump to any date range in your timeline with the built-in date picker
- **Broadcast delete** - Deletion requests are broadcast across 1400+ relays through a persistent, resumable queue (survives reloads and restarts) for thorough removal
- **Article mentions** - Nostr references and note embeds render inside longform articles
- **Custom Emojis & animated GIFs** - Render NIP-30 custom emojis from any author out of the box. Optional Custom Emojis add-on lets you upload your own pack and use them as reactions or in posts
- **Opt-in client tag** - Choose whether your posts identify NoorNote as the publishing client
- **Silent Zaps** - Send anonymous zaps signed with a throwaway ephemeral key — your npub never appears on the kind:9734 request, recipient and onlookers see "Someone silently zapped"
- **EXIF stripping** - Strip GPS location, timestamps and camera fingerprints from photos before upload, in three selectable privacy levels — so a shared picture never leaks where or how it was taken
- **Multi-account** - Keep several identities and switch with one tap (full in-app on Desktop and Android; NIP-46 bunker accounts on every platform), with strict per-account isolation of settings and data
- **Bulk delete** - Remove many of your own posts at once by time range, with the same wide relay broadcast

### Add-Ons

NoorNote ships with optional features that you enable on demand under **Settings → Add-ons**. Disabled add-ons are lazy-loaded — their code stays out of the main bundle until you switch them on.

| Add-On | Description |
|--------|-------------|
| **Bookmarks** | Save notes and links to bookmark folders with drag-and-drop organization |
| **Tribes** | Custom user groups with dedicated timeline tabs |
| **Extended Follows** | Mutual badges, Zap In/Out stats, and mutual change detection for your follows list |
| **Wallet Balance** | Show your Lightning wallet balance in the sidebar with fiat conversion |
| **Profile Recognition** | Visual cues (blinking profile pictures) when people you follow change their name or avatar |
| **Marketplace** | Browse and publish NIP-99 classified listings, tag filters, image carousel, listings from people you follow injected into your timeline |
| **Follow Packs** | Discover and share curated lists of Nostr users to follow |
| **Follower Notification** | Get notified when someone new follows you — new-followers-only, with verification that keeps it free of false positives |
| **Hashtag Subscriptions** | Subscribe to any hashtag or word and get notified when someone posts a note containing it |
| **List Sync Mode** | Switch between Easy Mode (automatic sync) and Manual Mode (action buttons + Danger Zone for resetting corrupted list data) |
| **Word Filter** | Hide notes containing specific words from all timelines |
| **Custom Emojis** | Upload your own NIP-30 emoji pack (incl. animated GIFs) and use them as reactions and in posts |
| **Live Streams Player** | Watch NIP-53 live streams (e.g. zap.stream) inline in the timeline via HLS, and zap the stream directly so your sats appear in the stream's overlay |
| **Scheduled Posts** | Schedule notes and long-form articles to be published at a later date and time — via a NoorNote-operated hold-and-forward service, no private keys leave your device |
| **Badges** | Create NIP-58 reputation badges, award them to users, and accept or decline badges awarded to you |
| **Note taking** | A private, end-to-end-encrypted Markdown notebook (checklists, labels, colors, pins, reminders, archive) synced across your devices via Nostr |
| **Bulk delete** | Delete many of your own posts at once — list by time range, select, and batch-delete (NIP-09) with live progress |
| **Nostr-Majlis** | Islamic companion: prayer times (official Diyanet source or local calculation), prayer and holiday reminders, and community dhikr |

...and many more to come.

## Get Started

**Web:** [noornote.app](https://noornote.app) — no install needed, use with a browser extension like [Sidecar](https://chromewebstore.google.com/detail/sidecar-a-classy-nostr-si/moimlikilhheabdafocpmneehpblhiln)

**Desktop:** macOS and Linux downloads on [Releases](https://github.com/77elements/noornote/releases)

### macOS Note

Since the app is not signed, macOS will show an error ("app is damaged"). Run this in Terminal after installation:

```bash
xattr -cr /Applications/Noornote.app
```

## Screenshots

<table>
  <tr>
    <td><img src="https://image.nostr.build/33ba14d4478a2014e725fb1508abc912d21e15656cda3bbd630642f870329b8b.png" alt="Welcome Page"></td>
    <td><img src="https://image.nostr.build/fb151877c4f97a912a7d50da560715a95215fd2f01fe03f9541cd7fde4e411fe.png" alt="Timeline"></td>
    <td><img src="https://image.nostr.build/76f06ea53995e7ee920648f7cff6cbc8003be9481f5594bbe806ef41b062f74a.png" alt="Notifications"></td>
    <td><img src="https://image.nostr.build/9f957b8ac0ff651cd26a626ad41f3019589587b5216686486beca7398a84aff9.png" alt="Profile"></td>
  </tr>
  <tr>
    <td><img src="https://image.nostr.build/25344de4008899f03cfe3f19ed16891f44a1a122ddbaaa0d8506e518bc91232e.png" alt="Thread"></td>
    <td><img src="https://image.nostr.build/dcaa8f478eef78d69613c52db0ae4a2cb9a89c870f372ebf0c87eed9841e61a8.png" alt="Themes"></td>
  </tr>
</table>

## Privacy & Security

- **No tracking** - Zero analytics, no data collection
- **Local-first lists** - Follows, bookmarks, and mutes are stored locally with optional relay sync
- **Encrypted local storage** - Sensitive data (nsec, NWC string) stored in encrypted local files
- **No false anonymity** - NoorNote makes sure the client itself reveals nothing about you (no client tag by default, no device/OS fingerprint, no analytics). It does not, and no Nostr client can, make you anonymous: your key is your identity, and your OS still sees your plaintext and IP.
- **No bundled Tor/VPN, on purpose** - An in-app proxy toggle would create a false sense of safety on a platform we don't control, and real anonymity is a whole-system discipline (Tails/Whonix level), not a checkbox. If you want IP-level privacy, run a system-wide VPN or Tor yourself; NoorNote routes through it transparently. If you want **full anonymity, that is on you, end to end**: from the OS stack down to your online behavior. No single switch and no single tool can deliver it.

## Troubleshooting

If the app crashes, check the log files:

| System | Log Location |
|--------|--------------|
| Linux | `~/.local/share/com.noornote.desktop/logs/` |
| macOS | `~/Library/Logs/com.noornote.desktop/` |

## Login Options

| Method | Platform | Security | Convenience |
|--------|----------|----------|-------------|
| [NoorSigner](https://github.com/77elements/noorsigner) | Desktop | High | High |
| NIP-07 Browser Extension (e.g. Sidecar) | Web | High | High |
| NIP-46 Remote Signer | All | High | Medium |

**Desktop:** Use NoorSigner for best security and convenience.
**Web:** Use a NIP-07 browser extension like Sidecar.

## NIPs Supported

| NIP | Description | Kind(s) |
|-----|-------------|---------|
| [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) | Basic protocol (notes, profiles) | 0, 1 |
| [NIP-02](https://github.com/nostr-protocol/nips/blob/master/02.md) | Follow list + public petnames | 3 |
| [NIP-04](https://github.com/nostr-protocol/nips/blob/master/04.md) | Encrypted DMs (legacy) | 4 |
| [NIP-05](https://github.com/nostr-protocol/nips/blob/master/05.md) | DNS-based verification | - |
| [NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md) | Browser extension signing | - |
| [NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md) | Event deletion | 5 |
| [NIP-10](https://github.com/nostr-protocol/nips/blob/master/10.md) | Reply threading | - |
| [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md) | Private Direct Messages | 13, 14, 1059, 10050 |
| [NIP-18](https://github.com/nostr-protocol/nips/blob/master/18.md) | Reposts & generic reposts | 6, 16 |
| [NIP-19](https://github.com/nostr-protocol/nips/blob/master/19.md) | bech32 encoding (npub, nsec, note, nevent, naddr) | - |
| [NIP-21](https://github.com/nostr-protocol/nips/blob/master/21.md) | `nostr:` URI scheme | - |
| [NIP-22](https://github.com/nostr-protocol/nips/blob/master/22.md) | Comments | 1111 |
| [NIP-23](https://github.com/nostr-protocol/nips/blob/master/23.md) | Long-form content (articles + drafts) | 30023, 30024 |
| [NIP-24](https://github.com/nostr-protocol/nips/blob/master/24.md) | Extra metadata fields and tags (banner, website, lud16, etc.) | - |
| [NIP-25](https://github.com/nostr-protocol/nips/blob/master/25.md) | Reactions | 7 |
| [NIP-27](https://github.com/nostr-protocol/nips/blob/master/27.md) | Text note references | - |
| [NIP-29](https://github.com/nostr-protocol/nips/blob/master/29.md) | Relay-based groups — read-only activity notifications (Nostrord add-on) | 9, 11, 39000, 10009 |
| [NIP-30](https://github.com/nostr-protocol/nips/blob/master/30.md) | Custom emojis (incl. animated GIFs) | 30030 |
| [NIP-33](https://github.com/nostr-protocol/nips/blob/master/33.md) | Parameterized replaceable events (addressable coordinates for articles, live streams, badges, follow packs, Zapstore apps, …) | 30023, 30030, 30311, 30009, 39089, 32267, 30617, 30402 |
| [NIP-34](https://github.com/nostr-protocol/nips/blob/master/34.md) | Git on Nostr (lightweight cards linking to gitworkshop.dev) | 1617, 1618, 1619, 1621, 1630, 1631, 1632, 1633, 30617 |
| [NIP-36](https://github.com/nostr-protocol/nips/blob/master/36.md) | Content warnings (NSFW) | - |
| [NIP-42](https://github.com/nostr-protocol/nips/blob/master/42.md) | Authentication of clients to relays | 22242 |
| [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md) | Encrypted payloads (modern encryption) | - |
| [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md) | Remote signing (bunker://) | 24133 |
| [NIP-47](https://github.com/nostr-protocol/nips/blob/master/47.md) | Nostr Wallet Connect | 23194, 23195 |
| [NIP-50](https://github.com/nostr-protocol/nips/blob/master/50.md) | Search | - |
| [NIP-51](https://github.com/nostr-protocol/nips/blob/master/51.md) | Lists (bookmarks, mutes, private follows, tribes) | 10000, 30000, 30003 |
| [NIP-53](https://github.com/nostr-protocol/nips/blob/master/53.md) | Live Activities (inline HLS player for live streams + chat input) | 1311, 30311 |
| [NIP-55](https://github.com/nostr-protocol/nips/blob/master/55.md) | Android signer application (Amber) | - |
| [NIP-56](https://github.com/nostr-protocol/nips/blob/master/56.md) | Reporting | 1984 |
| [NIP-57](https://github.com/nostr-protocol/nips/blob/master/57.md) | Zaps | 9734, 9735 |
| [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md) | Gift Wrap (used by NIP-17 DMs) | 1059 |
| [NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md) | Relay list metadata | 10002 |
| [NIP-68](https://github.com/nostr-protocol/nips/blob/master/68.md) | Picture events; user annotations in images (`annotate-user` in `imeta`) | 20 |
| [NIP-58](https://github.com/nostr-protocol/nips/blob/master/58.md) | Badges | 8, 30009, 10008, 30008 |
| [NIP-71](https://github.com/nostr-protocol/nips/blob/master/71.md) | Video events | 21, 22 |
| [NIP-73](https://github.com/nostr-protocol/nips/blob/master/73.md) | External content IDs (podcast shows & episodes, web pages) | - |
| [NIP-78](https://github.com/nostr-protocol/nips/blob/master/78.md) | Application-specific data (incl. private encrypted petnames) | 30078 |
| [NIP-84](https://github.com/nostr-protocol/nips/blob/master/84.md) | Highlights | 9802 |
| [NIP-88](https://github.com/nostr-protocol/nips/blob/master/88.md) | Polls | 1068, 1018 |
| [NIP-89](https://github.com/nostr-protocol/nips/blob/master/89.md) | App handlers (per-post `client` tag pointing to a kind 31990 handler, published via `/publish-nip --app`) | 31990 |
| [NIP-92](https://github.com/nostr-protocol/nips/blob/master/92.md) | Media attachments (`imeta` tags) | - |
| [NIP-94](https://github.com/nostr-protocol/nips/blob/master/94.md) | File metadata events in the timeline | 1063 |
| [NIP-96](https://github.com/nostr-protocol/nips/blob/master/96.md) | HTTP file storage | - |
| [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md) | HTTP auth | 27235 |
| [NIP-99](https://github.com/nostr-protocol/nips/blob/master/99.md) | Classified listings (marketplace) | 30402 |

**Other event kinds** (not tied to a numbered NIP — community specs, third-party APIs, NoorNote-internal):

- **Blossom upload auth** — kind `24242`, signed-event upload authorization for [Blossom](https://github.com/hzrd149/blossom)-style media servers
- **Capability profile** — kind `30817`, community-authored "NIP"-style capability profile, published via `/publish-nip` (Markdown body + `k`-tags listing supported kinds)
- **Follow Packs** — kind `39089`, used by the Follow Packs add-on and [calle's Follow Packs](https://github.com/callebtc/following.space)
- **Zapstore Apps** — kind `32267`, app metadata for [Zapstore](https://zapstore.dev/) listings
- **Zapstore Release Artifacts** — kind `30063`, release artifact metadata for Zapstore apps
- **Polls (legacy / Pollerama)** — kind `6969`, alternative poll format predating NIP-88
- **Primal Cache `USER_PROFILE_INFO`** — kind `10000105`, consumed from Primal's caching relay for `time_joined` lookup on profile pages
- **Mutual changes (NoorNote-internal)** — kind `99001`, synthesized for notifications when someone follows or unfollows you. Not published to relays.
- **Follower changes (NoorNote-internal)** — kind `99002`, synthesized for the Follower Notification addon when someone new follows you. Not published to relays.
- **Community dhikr activity (NoorNote-internal)** — kind `99003`, synthesized for the Nostr-Majlis addon to notify about new dhikr rounds, significant commits and reached goals. Not published to relays.
- **Bookmark list (legacy)** — kind `10003`, NIP-51 legacy bookmark list (read for migration; new bookmarks go in kind `30003`)
- **Ditto geocache** — kind `37516`, proprietary [Ditto](https://ditto.pub) feature with no NIP; rendered as a notice with an "open in Ditto" link instead of broken output

## Build from Source

Complete guide for building NoorNote (Web, Desktop, Android) and NoorSigner from source.

### System Requirements

**All Platforms:**
- Bun latest (install via [bun.sh](https://bun.sh))
- Node.js 22+ (for `electron-builder`)
- Go 1.24+ (only if you also build NoorSigner from source — Desktop only)

**Android (additional):**
- Android Studio + Android SDK (`ANDROID_HOME` env var set)
- JDK 21

**Linux Desktop note:** `bun install` has a known bug with platform-specific optionalDependencies (rollup, esbuild). On Linux use `npm install --legacy-peer-deps` instead of `bun install`.

### Step 1: Clone

```bash
git clone https://github.com/77elements/noornote.git
cd noornote
bun install   # or: npm install --legacy-peer-deps  (Linux)
```

### Step 2: Build NoorSigner (Desktop only)

NoorNote bundles the [NoorSigner](https://github.com/77elements/noorsigner) daemon as a sidecar binary. Skip this step if you're only targeting Web or Android.

```bash
git clone https://github.com/77elements/noorsigner.git ../noorsigner
cd ../noorsigner
go build -o noorsigner -ldflags="-s -w" .
cd ../noornote

# Copy into the platform folder Electron expects
mkdir -p binaries/$(uname -s | tr A-Z a-z)-$(uname -m | sed 's/x86_64/x64/' | sed 's/aarch64/arm64/')
cp ../noorsigner/noorsigner binaries/*/
```

### Step 3: Web build (Vite)

```bash
bun run dev    # http://localhost:5173 — vanilla web app, no Electron
```

Production:
```bash
bun run build  # outputs to dist/
```

### Step 4: Desktop (Electron)

Officially supported targets:
- **macOS** Apple Silicon (arm64) — Intel macs are not built by CI
- **Linux** x64 and arm64

In one terminal:
```bash
bun run dev
```
In another terminal:
```bash
bun run electron:dev   # launches Electron pointing at the Vite dev server
```

Production build:
```bash
ELECTRON_BUILD=1 bun run build
npx electron-builder --mac --arm64        # macOS Apple Silicon
# or:
npx electron-builder --linux --x64        # Linux x64
npx electron-builder --linux --arm64      # Linux arm64
```

Artifacts land in `dist-electron/`: `.dmg` (macOS), `.deb` / `.AppImage` / `.tar.gz` (Linux). The same flow runs in CI via `.github/workflows/build-desktop.yml` on every `v*` tag.

### Step 5: Android (Capacitor)

> Android is **not** built by CI yet — APKs are produced locally only.

```bash
export ANDROID_HOME=~/Library/Android/sdk    # macOS
# or:
export ANDROID_HOME=~/Android/Sdk             # Linux

bun run build
npx cap sync android
cd android && ./gradlew :app:assembleRelease
```

The unsigned APK lands in `android/app/build/outputs/apk/release/`. See `.claude/skills/apk/SKILL.md` for the full sign + zipalign + verify flow.

## Tech Stack

- **Frontend:** TypeScript, Vanilla JS, SASS
- **Desktop:** Electron
- **Android:** Capacitor
- **Nostr:** NDK (Nostr Dev Kit)
- **Build:** Vite
- **Package Manager:** Bun

## License

MIT

## Links

- [Nostr Protocol](https://nostr.com)
- [Report Issues](https://github.com/77elements/noornote/issues)
