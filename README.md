# NoorNote

**NoorNote** (Arabic: نور, meaning "light") is a fast, feature-rich, privacy-focused client for [Nostr](https://nostr.com) - the decentralized social protocol.

**Available as [Web App](https://noornote.app) and Desktop App (macOS, Linux).** Windows is not officially supported.

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
- **Marketplace** - Browse and publish NIP-99 classified listings, tag filters, image carousel, listings from people you follow injected into your timeline

### Highlights
- **Beginner-friendly onboarding** - Step-by-step profile setup with guided explanations, first follows via [calle's Follow Packs](https://github.com/callebtc/following.space), and Lightning wallet setup with [Rizful](https://rizful.com)
- **Spotlight-like search** - Search by Event, Username, npub and full-text. With built-in browsing history. Quick access to anything with CMD+K/CTRL+K
- **Search in npub** - Search for keywords within a specific user's posts
- **Rich Bookmarks** - Sortable lists with folder organization
- **Custom Bookmarks** - Bookmark any URL, just like in a browser
- **Mute Threads** - Say bye to hell threads
- **Follow lists** - With mutual badges and zap balances
- **Quoted reposts** - Shown in note's replies
- **Article notifications** - Get notified on new articles per user
- **Analytics per note** - See who liked, reposted, quoted, replied, or zapped
- **Thread mention alerts** - Get notified when someone replies to a note you were mentioned in
- **Local list backups** - Manual NIP-51 list management, never lose your follows, bookmarks, or mutes again
- **Multiple NIP-05 support** - Add multiple verified addresses to your profile
- **Tribes** - Custom user groups with dedicated timeline tabs
- **Hashtag subscriptions** - Subscribe to hashtags and get notified on new posts
- **Image reposts** - Share images with automatic source attribution
- **Notification priorities** - Drag & drop to customize notification order
- **Rich DM content** - Links, media, mentions, and quoted notes in direct messages
- **7 color themes** - Deep Purple, Bright Superman, Code Bunker, Soft Lilac, Dark Symbiote, Neon Harley, Wake up Neo
- **Font size controls** - Adjustable text size with persistent preference
- **Layout modes** - Phone mode and customizable layout options
- **Bookmark folders on profile** - Mount folders to share them publicly
- **Mutual change alerts** - Get notified when someone stops following back
- **Who zapped you most** - Sort follows by zap balance to see top supporters
- **Hijri calendar** - Islamic date display alongside Gregorian dates
- **Relay browsing** - Filter timeline to show content from specific relays
- **Time Machine** - Jump to any date range in your timeline with the built-in date picker
- **Broadcast delete** - Notes are deleted across 159+ relays for thorough removal
- **Article mentions** - Nostr references and note embeds render inside longform articles

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
| [NIP-23](https://github.com/nostr-protocol/nips/blob/master/23.md) | Long-form content (articles) | 30023 |
| [NIP-25](https://github.com/nostr-protocol/nips/blob/master/25.md) | Reactions | 7 |
| [NIP-27](https://github.com/nostr-protocol/nips/blob/master/27.md) | Text note references | - |
| [NIP-36](https://github.com/nostr-protocol/nips/blob/master/36.md) | Content warnings (NSFW) | - |
| [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md) | Encrypted payloads (modern encryption) | - |
| [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md) | Remote signing (bunker://) | 24133 |
| [NIP-47](https://github.com/nostr-protocol/nips/blob/master/47.md) | Nostr Wallet Connect | 23194, 23195 |
| [NIP-50](https://github.com/nostr-protocol/nips/blob/master/50.md) | Search | - |
| [NIP-51](https://github.com/nostr-protocol/nips/blob/master/51.md) | Lists (bookmarks, mutes, private follows) | 10000, 10003, 30000 |
| [NIP-56](https://github.com/nostr-protocol/nips/blob/master/56.md) | Reporting | 1984 |
| [NIP-57](https://github.com/nostr-protocol/nips/blob/master/57.md) | Zaps | 9734, 9735 |
| [NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md) | Relay list metadata | 10002 |
| [NIP-68](https://github.com/nostr-protocol/nips/blob/master/68.md) | Picture events | 20 |
| [NIP-71](https://github.com/nostr-protocol/nips/blob/master/71.md) | Video events | 21, 22 |
| [NIP-78](https://github.com/nostr-protocol/nips/blob/master/78.md) | Application-specific data | 30078 |
| [NIP-88](https://github.com/nostr-protocol/nips/blob/master/88.md) | Polls | 1068, 1018 |
| [NIP-96](https://github.com/nostr-protocol/nips/blob/master/96.md) | HTTP file storage | 24242 |
| [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md) | HTTP auth | 27235 |
| [NIP-99](https://github.com/nostr-protocol/nips/blob/master/99.md) | Classified listings (marketplace) | 30402 |

## Build from Source

Complete guide for building NoorNote and NoorSigner from source on all supported platforms.

### System Requirements

**All Platforms:**
- Bun latest (install via [bun.sh](https://bun.sh))
- Rust 1.70+ (install via [rustup](https://rustup.rs/))
- Go 1.24+ (for NoorSigner)

**Linux:**
```bash
# Debian/Ubuntu
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev librsvg2-dev patchelf libsecret-1-dev

# Fedora/RHEL
sudo dnf install webkit2gtk4.1-devel gtk3-devel libsoup3-devel \
  javascriptcoregtk4.1-devel librsvg2-devel patchelf libsecret-devel

# Arch Linux
sudo pacman -S webkit2gtk-4.1 gtk3 libsoup3 librsvg patchelf libsecret
```

**macOS:**
- Xcode Command Line Tools: `xcode-select --install`

### Step 1: Clone Repositories

```bash
# Clone NoorNote
git clone https://github.com/77elements/noornote.git
cd noornote

# Clone NoorSigner (sibling directory)
cd ..
git clone https://github.com/77elements/noorsigner.git
```

### Step 2: Build NoorSigner

Build NoorSigner for your platform. **Choose ONE** based on your system:

**Linux x64:**
```bash
cd noorsigner
GOOS=linux GOARCH=amd64 go build -o noorsigner-x86_64-unknown-linux-gnu -ldflags="-s -w" .
```

**Linux ARM64:**
```bash
cd noorsigner
GOOS=linux GOARCH=arm64 go build -o noorsigner-aarch64-unknown-linux-gnu -ldflags="-s -w" .
```

**macOS Intel (x86_64):**
```bash
cd noorsigner
GOOS=darwin GOARCH=amd64 go build -o noorsigner-x86_64-apple-darwin -ldflags="-s -w" .
```

**macOS Apple Silicon (ARM64):**
```bash
cd noorsigner
GOOS=darwin GOARCH=arm64 go build -o noorsigner-aarch64-apple-darwin -ldflags="-s -w" .
```

### Step 3: Copy NoorSigner Binary

Copy the binary you just built to NoorNote's binaries folder. **Use the command matching your platform from Step 2:**

```bash
cd ../noornote
mkdir -p src-tauri/binaries
```

Then **one** of these:
```bash
# Linux x64:
cp ../noorsigner/noorsigner-x86_64-unknown-linux-gnu src-tauri/binaries/

# Linux ARM64:
cp ../noorsigner/noorsigner-aarch64-unknown-linux-gnu src-tauri/binaries/

# macOS Intel:
cp ../noorsigner/noorsigner-x86_64-apple-darwin src-tauri/binaries/

# macOS ARM64:
cp ../noorsigner/noorsigner-aarch64-apple-darwin src-tauri/binaries/
```

### Step 4: Build NoorNote

**Development Mode:**
```bash
bun install
bun run tauri:dev
```

**Production Build:**
```bash
bun run tauri build
```

Build artifacts will be in `src-tauri/target/release/bundle/`:
- **Linux:** `.deb`, `.rpm`, `.tar.gz`
- **macOS:** `.dmg`, `.app`

### Troubleshooting

**Error: `noorsigner-*` binary not found**
- Ensure Step 2-3 completed successfully
- Verify binary exists: `ls -la src-tauri/binaries/`

**Linux: webkit2gtk errors**
- Install system dependencies (see System Requirements)
- Try: `sudo ldconfig` after installing libs

**macOS: Code signing errors**
- Development builds don't need signing
- For distribution: see [Tauri signing docs](https://v2.tauri.app/distribute/sign/macos/)

## Tech Stack

- **Frontend:** TypeScript, Vanilla JS, SASS
- **Desktop:** Tauri 2.0 (Rust)
- **Nostr:** NDK (Nostr Dev Kit)
- **Build:** Vite
- **Package Manager:** Bun

## License

MIT

## Links

- [Nostr Protocol](https://nostr.com)
- [Report Issues](https://github.com/77elements/noornote/issues)
