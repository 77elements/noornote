# NoorNote

**NoorNote** (Arabic: نور, meaning "light") is a fast, feature-rich, privacy-focused client for [Nostr](https://nostr.com) - the decentralized social protocol.

**Available as [Web App](https://noornote.app), Desktop App (macOS, Linux), and Android App.**

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
- **Marketplace** - Browse and publish NIP-99 classified listings

### Highlights
- **Beginner-friendly onboarding** - Step-by-step profile setup with guided explanations
- **Spotlight-like search** - CMD+K/CTRL+K for quick access to anything
- **Rich Bookmarks** - Sortable lists with folder organization
- **Tribes** - Custom user groups with dedicated timeline tabs
- **7 color themes** - Deep Purple, Bright Superman, Code Bunker, and more
- **Hijri calendar** - Islamic date display alongside Gregorian dates

...and many more.

## Get Started

**Web:** [noornote.app](https://noornote.app) — no install needed

**Desktop:** macOS and Linux downloads on [Releases](https://github.com/77elements/noornote/releases)

**Android:** APK download on [Releases](https://github.com/77elements/noornote/releases) — uses [Amber](https://github.com/greenart7c3/Amber) for key management

### macOS Note

Since the app is not signed, macOS will show an error ("app is damaged"). Run this in Terminal after installation:

```bash
xattr -cr /Applications/Noornote.app
```

## Login Options

| Method | Platform | Security |
|--------|----------|----------|
| [NoorSigner](https://github.com/77elements/noorsigner) | Desktop | High |
| [Amber](https://github.com/greenart7c3/Amber) (NIP-55) | Android | High |
| NIP-07 Browser Extension (e.g. Alby) | Web | High |
| NIP-46 Remote Signer | All | High |

## Build from Source

### Requirements

- Bun latest ([bun.sh](https://bun.sh))
- Node.js 22+ (for electron-builder)
- Go 1.24+ (for NoorSigner)

### Desktop (Electron)

```bash
git clone https://github.com/77elements/noornote.git
cd noornote
bun install

# Build NoorSigner
git clone https://github.com/77elements/noorsigner.git ../noorsigner
cd ../noorsigner
go build -o noorsigner -ldflags="-s -w" .
cd ../noornote
mkdir -p binaries/$(uname -s | tr A-Z a-z)-$(uname -m | sed 's/x86_64/x64/' | sed 's/aarch64/arm64/')
cp ../noorsigner/noorsigner binaries/*/

# Development
bun run dev          # Start Vite dev server
bun run electron:dev # Start Electron (in second terminal)

# Production build
bun run build
npx electron-builder
```

### Android (Capacitor)

```bash
# Requires Android SDK
export ANDROID_HOME=~/Library/Android/sdk  # macOS
bun run build
npx cap sync android
cd android && ./gradlew :app:assembleRelease
```

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
