# NosPress Custom Fonts — PHP Upload Endpoint

NIP-98-authenticated webfont upload, hosted at `https://noornote.app/_nospress-user/fonts/`.

Lives under `_nospress-user/` to keep user uploads strictly separated from
the app's own `/fonts/` directory (Saira logo font etc.) — re-uploading `dist/`
on app updates can never overwrite a user dir by accident.

**No composer, no vendor folder, no build step.** Pure PHP — only the standard
`ext-gmp` extension required (enabled on virtually every shared host).

## Files

| File | Purpose |
|------|---------|
| `upload.php` | `POST /_nospress-user/fonts/upload.php?family=<name>` — multipart/form-data with a `file` part. NIP-98 `Authorization` header signs the request. |
| `delete.php` | `POST /_nospress-user/fonts/delete.php` — body `{"url":"..."}` — only the owner npub (per NIP-98 signature) can delete. |
| `lib/Nip98.php` | NIP-98 (kind:27235) header parser + invariant checks. |
| `lib/Bip340Verify.php` | Self-contained BIP-340 Schnorr verification in pure PHP. |
| `lib/Bech32.php` | Pure-PHP bech32 encoder (hex pubkey → npub) for directory + URL naming. |
| `.htaccess` | Webfont MIME types, file-size caps, CORS, long cache. |
| `index.html` | Empty — prevents directory listing fallback. |

## Hosting requirements

- PHP ≥ 8.0
- `ext-gmp` (check via `phpinfo()` — almost always enabled on shared hosting; if missing, ask the provider to enable it)
- Write access to the `_nospress-user/fonts/` directory (chmod 755 / 775 typical on cPanel)

## Deploy

These files live in `public/_nospress-user/fonts/` in source. `bun run build` copies
them verbatim into `dist/_nospress-user/fonts/`, which is included in the FTP-sync
to `public_html/`. No separate deploy step.

After `bun run build`:

```
dist/_nospress-user/fonts/
  upload.php
  delete.php
  lib/
    Nip98.php
    Bip340Verify.php
    Bech32.php
  .htaccess
  index.html
  <npub1…>/              ← created on first upload, contains the user's files
```

## Sanity check after deploy

```bash
# Health
curl https://noornote.app/_nospress-user/fonts/upload.php
# → {"ok":true,"version":"1"}

# BIP-340 Schnorr self-test (verifies the crypto with official BIP-340 vectors)
curl 'https://noornote.app/_nospress-user/fonts/upload.php?selftest=1'
# → {"ok":true,"selftest":"passed","vectors":4}
```

A real upload happens from inside NoorNote: Global tab → Fonts → Add font.

## Limits / Policy

- Max file size: **2 MB** per font
- Allowed formats (magic-byte check): **woff2, woff, ttf, otf**
- Max files per npub: **20** (soft cap — adjust in `upload.php`)
- File name sanitized to `[a-z0-9-]{1,40}\.<ext>` (lowercase, ASCII only)
- NIP-98 freshness window: **60 seconds** (per spec)
- `payload` tag verified against SHA-256 of the file body
