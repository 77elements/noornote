/**
 * BUD-10 `blossom:` URI parsing — https://github.com/hzrd149/blossom/blob/master/udds/10.md
 *
 * A blossom URI is a content-addressed blob reference, akin to a magnet link:
 *
 *   blossom:<sha256>.<ext>?xs=<server>&xs=<server2>&as=<hex-pubkey>&sz=<bytes>
 *
 * - `hash` (required): lowercase 64-char SHA-256 hex of the blob.
 * - `ext` (optional): file extension; unknown/missing → `.bin` fallback per spec.
 * - `xs` (repeatable): server hints, tried first, in order.
 * - `as` (repeatable): author hex pubkeys whose kind:10063 (BUD-03) server
 *   lists are the recovery path.
 * - `sz` (optional): expected size in bytes (integrity/sanity check).
 *
 * Tolerance: some clients emit `blossom://<hash>` (double slash) — accepted and
 * normalized to the single-colon canonical form.
 */

export interface BlossomUriInfo {
  /** Canonical URI form: `blossom:<hash>[.<ext>][?<query>]` */
  raw: string;
  /** Lowercase 64-char SHA-256 hex. */
  hash: string;
  /** File extension without dot (lowercase), when present. */
  ext?: string;
  /** Normalized https:// server hints (`xs`), in declaration order. */
  servers: string[];
  /** Author hex pubkeys (`as`), in declaration order. */
  authors: string[];
  /** Expected size in bytes (`sz`), when present and valid. */
  size?: number;
}

/** 64 lowercase hex chars. */
const HASH_PATTERN = /[a-f0-9]{64}/i;

/** Trailing punctuation that glued a URI into prose ("…, blossom:…." etc.). */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"]+$/;

/**
 * Match a `blossom:` URI (spec single-colon plus tolerated `blossom://` form).
 * Group 1 = hash, group 2 = extension, group 3 = query string (with `?`).
 */
export const BLOSSOM_URI_REGEX =
  /blossom:\/{0,2}([a-fA-F0-9]{64})(?:\.([a-zA-Z0-9]{1,12}))?(\?[^\s]*)?/gi;

/** Normalize a server hint to an https:// URL. Returns null for garbage. */
export function normalizeBlossomServer(hint: string): string | null {
  const trimmed = hint.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    // Reject hints containing a path — a blossom server hint is an origin.
    if (url.pathname && url.pathname !== '/') return null;
    return `${url.protocol.toLowerCase()}//${
      url.hostname.toLowerCase() + (url.port ? `:${url.port}` : '')
    }`;
  } catch {
    return null;
  }
}

/**
 * Parse a BUD-10 blossom URI. Returns null for anything that is not a
 * structurally valid URI (wrong hash length, bad sz, no hash at all).
 */
export function parseBlossomUri(raw: string): BlossomUriInfo | null {
  BLOSSOM_URI_REGEX.lastIndex = 0;
  const match = BLOSSOM_URI_REGEX.exec(raw.trim());
  if (!match) return null;
  return buildUriInfo(match[0]);
}

/** Parse from a full-text match — used by the extractor on `String.match` results. */
export function buildUriInfo(rawMatch: string): BlossomUriInfo | null {
  // Trim prose punctuation glued onto the match (", blossom:…." etc.).
  let raw = rawMatch.trim().replace(TRAILING_PUNCTUATION, '');
  // Tolerate `blossom://` by canonicalizing to `blossom:` for hashing/parsing.
  raw = raw.replace(/^blossom:\/\//i, 'blossom:');

  const m =
    /^blossom:([a-fA-F0-9]{64})(?:\.([a-zA-Z0-9]{1,12}))?(\?[^\s]*)?$/.exec(
      raw
    );
  if (!m) return null;

  const hash = m[1]!.toLowerCase();
  const ext = m[2]?.toLowerCase();

  const servers: string[] = [];
  const authors: string[] = [];
  let size: number | undefined;

  if (m[3]) {
    const params = new URLSearchParams(m[3].slice(1));
    for (const server of params.getAll('xs')) {
      const normalized = normalizeBlossomServer(server);
      if (normalized && !servers.includes(normalized)) servers.push(normalized);
    }
    for (const author of params.getAll('as')) {
      const pubkey = author.trim().toLowerCase();
      if (
        HASH_PATTERN.test(pubkey) &&
        pubkey.length === 64 &&
        !authors.includes(pubkey)
      ) {
        authors.push(pubkey);
      }
    }
    const sz = params.get('sz');
    if (sz !== null) {
      const parsed = Number(sz);
      if (Number.isFinite(parsed) && parsed > 0) size = Math.floor(parsed);
    }
  }

  return {
    raw,
    hash,
    ...(ext && { ext }),
    servers,
    authors,
    ...(size !== undefined && { size }),
  };
}

/** Canonical server blob URL: `https://<server>/<hash>[.<ext>]` (BUD-01 `GET /<sha256>`). */
export function blobUrlFor(server: string, info: BlossomUriInfo): string {
  const ext = info.ext || 'bin';
  return `${server.replace(/\/+$/, '')}/${info.hash}.${ext}`;
}

/** Guess the render type from a file extension. Defaults to 'image'. */
export function renderTypeForExt(
  ext: string | undefined
): 'image' | 'video' | 'audio' | 'epub' {
  switch (ext?.toLowerCase()) {
    case 'jpg':
    case 'jpeg':
    case 'png':
    case 'gif':
    case 'webp':
    case 'svg':
      return 'image';
    case 'mp4':
    case 'webm':
    case 'mov':
    case 'avi':
      return 'video';
    case 'mp3':
    case 'wav':
    case 'ogg':
    case 'flac':
    case 'm4a':
    case 'aac':
      return 'audio';
    case 'epub':
      return 'epub';
    default:
      return 'image';
  }
}

/** Guess the render type from an HTTP content-type. Defaults to 'image'. */
export function renderTypeForContentType(
  contentType: string | null
): 'image' | 'video' | 'audio' | 'epub' {
  const ct = (contentType || '').toLowerCase();
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('audio/')) return 'audio';
  if (ct.includes('epub+zip')) return 'epub';
  return 'image';
}
