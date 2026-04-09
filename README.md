# NoorNote

**NoorNote** (Arabic: نور, meaning "light") is a fast, feature-rich, privacy-focused client for [Nostr](https://nostr.com) - the decentralized social protocol.

**Available as [Web App](https://noornote.app), Desktop App (macOS, Linux) and Android App.** Windows is not officially supported.

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
- **Broadcast delete** - Notes are deleted across 159+ relays for thorough removal
- **Article mentions** - Nostr references and note embeds render inside longform articles
- **Custom Emojis & animated GIFs** - Render NIP-30 custom emojis from any author out of the box. Optional Custom Emojis add-on lets you upload your own pack and use them as reactions or in posts
- **Opt-in client tag** - Choose whether your posts identify NoorNote as the publishing client

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
| **NostrIn** | Mount a bookmark folder or a custom user list to your profile so other NoorNote users can see them |
| **Hashtag Subscriptions** | Subscribe to any hashtag or word and get notified when someone posts a note containing it |
| **List Sync Mode** | Switch between Easy Mode (automatic sync) and Manual Mode (action buttons + Danger Zone for resetting corrupted list data) |
| **Word Filter** | Hide notes containing specific words from all timelines |
| **Custom Emojis** | Upload your own NIP-30 emoji pack (incl. animated GIFs) and use them as reactions and in posts |

...and many more to come.

## Get Started

**Web:** [noornote.app](https://noornote.app) — no install needed, use with a browser extension like [Alby](https://getalby.com)

**Desktop:** macOS and Linux downloads on [Releases](https://github.com/77elements/noornote/releases)

### macOS Note

Since the app is not signed, macOS will show an error ("app is damaged"). Run this in Terminal after installation:

```bash
xattr -cr /Applications/Noornote.app
```

## Screenshot

![NoorNote Timeline](https://image.nostr.build/5831d6aeb91665e25e241277fb96a7df5596c8f316fe6543c7919cf00f1e71cc.png)

## Privacy & Security

- **No tracking** - Zero analytics, no data collection
- **Local-first lists** - Follows, bookmarks, and mutes are stored locally with optional relay sync
- **Encrypted local storage** - Sensitive data (nsec, NWC string) stored in encrypted local files

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
| NIP-07 Browser Extension (e.g. Alby) | Web | High | High |
| NIP-46 Remote Signer | All | High | Medium |

**Desktop:** Use NoorSigner for best security and convenience.
**Web:** Use a NIP-07 browser extension like Alby.

## NIPs Supported

| NIP | Description | Kind(s) |
|-----|-------------|---------|
| [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) | Basic protocol (notes, profiles) | 0, 1 |
| [NIP-02](https://github.com/nostr-protocol/nips/blob/master/02.md) | Follow list | 3 |
| [NIP-04](https://github.com/nostr-protocol/nips/blob/master/04.md) | Encrypted DMs (legacy) | 4 |
| [NIP-05](https://github.com/nostr-protocol/nips/blob/master/05.md) | DNS-based verification | - |
| [NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md) | Browser extension signing | - |
| [NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md) | Event deletion | 5 |
| [NIP-10](https://github.com/nostr-protocol/nips/blob/master/10.md) | Reply threading | - |
| [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md) | Private Direct Messages | 13, 14, 1059, 10050 |
| [NIP-18](https://github.com/nostr-protocol/nips/blob/master/18.md) | Reposts | 6 |
| [NIP-19](https://github.com/nostr-protocol/nips/blob/master/19.md) | bech32 encoding (npub, nsec, note, nevent, naddr) | - |
| [NIP-22](https://github.com/nostr-protocol/nips/blob/master/22.md) | Comments | 1111 |
| [NIP-23](https://github.com/nostr-protocol/nips/blob/master/23.md) | Long-form content (articles + drafts) | 30023, 30024 |
| [NIP-25](https://github.com/nostr-protocol/nips/blob/master/25.md) | Reactions | 7 |
| [NIP-27](https://github.com/nostr-protocol/nips/blob/master/27.md) | Text note references | - |
| [NIP-30](https://github.com/nostr-protocol/nips/blob/master/30.md) | Custom emojis (incl. animated GIFs) | 30030 |
| [NIP-36](https://github.com/nostr-protocol/nips/blob/master/36.md) | Content warnings (NSFW) | - |
| [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md) | Encrypted payloads (modern encryption) | - |
| [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md) | Remote signing (bunker://) | 24133 |
| [NIP-47](https://github.com/nostr-protocol/nips/blob/master/47.md) | Nostr Wallet Connect | 23194, 23195 |
| [NIP-50](https://github.com/nostr-protocol/nips/blob/master/50.md) | Search | - |
| [NIP-51](https://github.com/nostr-protocol/nips/blob/master/51.md) | Lists (bookmarks, mutes, private follows, tribes) | 10000, 30000, 30003 |
| [NIP-53](https://github.com/nostr-protocol/nips/blob/master/53.md) | Live Activities (inline HLS player for live streams) | 30311 |
| [NIP-56](https://github.com/nostr-protocol/nips/blob/master/56.md) | Reporting | 1984 |
| [NIP-57](https://github.com/nostr-protocol/nips/blob/master/57.md) | Zaps | 9734, 9735 |
| [NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md) | Relay list metadata | 10002 |
| [NIP-68](https://github.com/nostr-protocol/nips/blob/master/68.md) | Picture events | 20 |
| [NIP-71](https://github.com/nostr-protocol/nips/blob/master/71.md) | Video events | 21, 22 |
| [NIP-78](https://github.com/nostr-protocol/nips/blob/master/78.md) | Application-specific data | 30078 |
| [NIP-88](https://github.com/nostr-protocol/nips/blob/master/88.md) | Polls | 1068, 1018 |
| [NIP-94](https://github.com/nostr-protocol/nips/blob/master/94.md) | File metadata events in the timeline | 1063 |
| [NIP-96](https://github.com/nostr-protocol/nips/blob/master/96.md) | HTTP file storage | 24242 |
| [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md) | HTTP auth | 27235 |
| [NIP-99](https://github.com/nostr-protocol/nips/blob/master/99.md) | Classified listings (marketplace) | 30402 |

**Additional community kinds:** Follow Packs (kind `39089`, used by the Follow Packs add-on and [calle's Follow Packs](https://github.com/callebtc/following.space)).

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
