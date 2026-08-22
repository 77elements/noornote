/**
 * Deterministic avatar fallback — generates a stable HSL-colored data-URL SVG
 * from a hex pubkey. Used wherever a profile picture is missing (cache miss,
 * profile has no `picture` field, fetch failed). Same pubkey always yields the
 * same color, so the same user looks consistent across the app.
 */
export function getAvatarFallback(hexPubkey: string): string {
  const slice = hexPubkey.slice(8, 14) || '000000';
  const hue = parseInt(slice.slice(0, 3), 16) % 360;
  const sat = 45 + (parseInt(slice.slice(3, 4), 16) % 30);
  const light = 35 + (parseInt(slice.slice(4, 6), 16) % 25);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="hsl(${hue} ${sat}% ${light}%)"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * Install a single capture-phase listener that swaps any broken `.profile-pic`
 * image to a deterministic identicon. Covers 404s, CORS failures, network
 * errors — cases the cache cannot know about until the browser tries to load
 * the URL. Idempotent: safe to call multiple times.
 *
 * The pubkey is read from `data-pubkey` on the `<img>` (or its closest
 * ancestor) so the swap stays deterministic per user. Without a pubkey the
 * image is left alone (rare; renderers should set the attribute).
 */
let imgErrorListenerInstalled = false;
export function installImgErrorFallback(): void {
  if (imgErrorListenerInstalled) return;
  imgErrorListenerInstalled = true;
  document.addEventListener(
    'error',
    e => {
      const target = e.target as HTMLElement | null;
      if (!target || target.tagName !== 'IMG') return;
      const img = target as HTMLImageElement;
      if (!img.classList.contains('profile-pic')) return;
      const pubkey =
        img.dataset.pubkey ||
        img.closest<HTMLElement>('[data-pubkey]')?.dataset.pubkey;
      if (!pubkey) return;
      const fallback = getAvatarFallback(pubkey);
      if (img.src === fallback) return; // already swapped
      img.src = fallback;
    },
    true
  ); // capture phase — `error` does not bubble from <img>
}
