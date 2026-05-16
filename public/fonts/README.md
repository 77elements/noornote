# NosPress Custom Fonts — PHP Upload Endpoint

NIP-98-authenticated webfont upload, hosted at `https://noornote.app/fonts/`.

**No composer, no vendor folder, no build step.** Pure PHP — only the standard
`ext-gmp` extension required (enabled on virtually every shared host).

## Files

| File | Purpose |
|------|---------|
| `upload.php` | `POST /fonts/upload.php?family=<name>` — accepts the raw font bytes as the request body. NIP-98 `Authorization` header signs the request. |
| `delete.php` | `POST /fonts/delete.php` — body `{"url":"..."}` — only the owner pubkey (per NIP-98 signature) can delete. |
| `lib/Nip98.php` | NIP-98 (kind:27235) header parser + invariant checks. |
| `lib/Bip340Verify.php` | Self-contained BIP-340 Schnorr verification in pure PHP. |
| `.htaccess` | Webfont MIME types, file-size caps, CORS, long cache. |
| `index.html` | Empty — prevents directory listing fallback. |

## Hosting requirements

- PHP ≥ 8.0
- `ext-gmp` (check via `phpinfo()` — almost always enabled on shared hosting; if missing, ask the provider to enable it)
- Write access to the `fonts/` directory (chmod 755 / 775 typical on cPanel)

## Deploy

These files live in `public/fonts/` in source. `bun run build` copies them
verbatim into `dist/fonts/`, which is the directory you FTP into
`public_html/`. No separate deploy step.

After `bun run build`:

```
dist/fonts/
  upload.php
  delete.php
  lib/
    Nip98.php
    Bip340Verify.php
  .htaccess
  index.html
  Saira/                 ← existing app logo font (untouched)
  <pubkey>/              ← created on first upload, contains the user's files
```

## Sanity check after deploy

```bash
# Health
curl https://noornote.app/fonts/upload.php
# → {"ok":true,"version":"1"}

# BIP-340 Schnorr self-test (verifies the crypto with official BIP-340 vectors)
curl https://noornote.app/fonts/upload.php?selftest=1
# → {"ok":true,"selftest":"passed","vectors":4}
```

A real upload happens from inside NoorNote: Global tab → Custom Fonts → Add font.

## Limits / Policy

- Max file size: **2 MB** per font
- Allowed formats (magic-byte check): **woff2, woff, ttf, otf**
- Max files per pubkey: **20** (soft cap — adjust in `upload.php`)
- File name sanitized to `[a-z0-9-]{1,40}\.<ext>` (lowercase, ASCII only)
- NIP-98 freshness window: **60 seconds** (per spec)
- `payload` tag verified against SHA-256 of the file body
