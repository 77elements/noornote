# NoorNote Installation

## Web

No installation needed — use NoorNote directly in your browser:

**[noornote.app](https://noornote.app)**

---

## Linux (Ubuntu/Debian)

### Quick Install (recommended)

```bash
bash <(curl -s https://raw.githubusercontent.com/77elements/noornote/main/deployment/linux/quick-install.sh)
```

### Manual Installation

1. Download the `.deb` file from the [Releases page](https://github.com/77elements/noornote/releases)
2. Install:
   ```bash
   sudo apt install ./noornote_*.deb
   ```
3. Launch: `noornote`

---

## Linux (Fedora/RHEL)

1. Download the `.rpm` file from the [Releases page](https://github.com/77elements/noornote/releases)
2. Install:
   ```bash
   sudo rpm -i noornote-*.rpm
   ```
3. Launch: `noornote`

---

## Linux (Arch, other distros)

1. Download the tarball from the [Releases page](https://github.com/77elements/noornote/releases)
2. Extract and install:
   ```bash
   tar -xzf noornote-*.tar.gz
   cd noornote-*/
   ./install.sh
   ```

---

## macOS

1. Download the `.dmg` from the [Releases page](https://github.com/77elements/noornote/releases)
2. Open the DMG and drag `Noornote.app` to `/Applications`
3. **Important:** Since the app is not signed, macOS will block it. Run in Terminal:
   ```bash
   xattr -cr /Applications/Noornote.app
   ```
4. Now the app can be opened normally

---

## Supported Platforms

| Platform | Architecture |
|----------|-------------|
| macOS | ARM64 (Apple Silicon) |
| Linux | AMD64, ARM64 |
| Web | Any modern browser |

Windows is not supported.
