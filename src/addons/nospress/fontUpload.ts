/**
 * NosPress Custom Font upload client — talks to the PHP endpoint at
 * /fonts/upload.php (deployment/fonts/). NIP-98-authenticated; PHP enforces
 * size/format/quota.
 *
 * Returns the public URL + format hint so the caller can append the entry
 * to siteSettings.theme.customFonts and regenerate the @font-face block.
 */

import { buildNip98AuthHeader, sha256Hex } from '../../helpers/nip98';

/**
 * The font endpoint lives ONLY at noornote.app — there is no Electron /
 * Capacitor copy. NIP-98 signatures must include the canonical absolute
 * URL the server sees; signing the dev `localhost:3000` URL would break
 * verification (server computes `https://noornote.app/...` from its own
 * Host header). For the actual fetch we use a relative path so the Vite
 * dev-proxy can forward localhost requests to live PHP transparently.
 */
const FONT_HOST = 'https://noornote.app';
export const FONT_UPLOAD_ENDPOINT = '/fonts/upload.php';
export const FONT_DELETE_ENDPOINT = '/fonts/delete.php';

export interface UploadedFont {
  url: string;
  format: 'woff2' | 'woff' | 'truetype' | 'opentype';
  size: number;
}

/**
 * Upload one font file. `family` is the user-chosen CSS family name (also
 * used as the slug for the stored filename, server-sanitized).
 */
export async function uploadCustomFont(file: File, family: string): Promise<UploadedFont> {
  if (!family.trim()) throw new Error('Font name is required');

  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > 2 * 1024 * 1024) {
    throw new Error('Font file exceeds 2 MB');
  }

  // Use multipart/form-data — many shared hosts' mod_security WAFs block
  // `application/octet-stream` POSTs to .php (returns 406). NIP-98 payload
  // tag hashes the file bytes; server re-hashes the uploaded file part to
  // verify.
  const sha = await sha256Hex(bytes);
  const qs = `?family=${encodeURIComponent(family.trim())}`;
  const signedUrl = `${FONT_HOST}${FONT_UPLOAD_ENDPOINT}${qs}`;
  const fetchUrl  = `${FONT_UPLOAD_ENDPOINT}${qs}`;
  const auth = await buildNip98AuthHeader('POST', signedUrl, sha);

  const form = new FormData();
  form.append('file', new Blob([bytes]), file.name);

  const res = await fetch(fetchUrl, {
    method: 'POST',
    headers: { 'Authorization': auth },
    body: form
  });

  const rawText = await res.text();
  let body: { ok?: boolean; url?: string; format?: UploadedFont['format']; size?: number; error?: string } = {};
  try { body = JSON.parse(rawText); } catch { /* not JSON */ }
  if (!res.ok || !body.ok) {
    const detail = body.error
      ? body.error
      : `HTTP ${res.status} — response body: ${rawText.slice(0, 300) || '(empty)'}`;
    throw new Error(`Upload failed: ${detail}`);
  }
  return { url: body.url!, format: body.format!, size: body.size! };
}

/** Delete a previously uploaded font by its public URL. */
export async function deleteCustomFont(publicUrl: string): Promise<void> {
  const signedUrl = `${FONT_HOST}${FONT_DELETE_ENDPOINT}`;
  const fetchUrl  = FONT_DELETE_ENDPOINT;
  const bodyStr = JSON.stringify({ url: publicUrl });
  const sha = await sha256Hex(new TextEncoder().encode(bodyStr));
  const auth = await buildNip98AuthHeader('POST', signedUrl, sha);

  const res = await fetch(fetchUrl, {
    method: 'POST',
    headers: {
      'Authorization': auth,
      'Content-Type': 'application/json'
    },
    body: bodyStr
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    throw new Error(body.error || `Delete failed (HTTP ${res.status})`);
  }
}
