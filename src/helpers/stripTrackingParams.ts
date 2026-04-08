/**
 * Strip tracking/ref tokens from URLs inside arbitrary text before publishing.
 *
 * Currently scoped to YouTube URLs, the main offender on Nostr. Keeps only
 * the meaningful params (`v`, `t`, `list`) and drops everything else
 * (`pp`, `si`, `ab_channel`, `feature`, `utm_*`, `gclid`, `fbclid`, …).
 *
 * Runs at publish time so our users don't spam noisy links and the
 * "Tracking Token Disrespector" bot has nothing to reply to.
 */

const YT_KEEP_PARAMS = new Set(['v', 't', 'list']);

/**
 * Match any http(s) URL on a youtube.com / youtu.be host. We do NOT anchor
 * on `/watch?v=` so we also catch `youtu.be/<id>?si=…`, `music.youtube.com`,
 * `m.youtube.com`, etc.
 */
const YOUTUBE_URL_REGEX = /https?:\/\/(?:[a-z0-9-]+\.)?(?:youtube\.com|youtu\.be)\/[^\s]*/gi;

function cleanYouTubeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const kept: [string, string][] = [];
    url.searchParams.forEach((value, key) => {
      if (YT_KEEP_PARAMS.has(key)) kept.push([key, value]);
    });
    // Rebuild query string preserving the order of kept params
    const search = kept.length
      ? '?' + kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
      : '';
    // Drop hash too — YouTube doesn't use it meaningfully
    return `${url.origin}${url.pathname}${search}`;
  } catch {
    return raw;
  }
}

export function stripTrackingParams(text: string): string {
  if (!text) return text;
  return text.replace(YOUTUBE_URL_REGEX, (match) => cleanYouTubeUrl(match));
}
