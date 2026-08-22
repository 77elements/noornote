/**
 * Probe an image's intrinsic dimensions via `new Image()` + onload.
 *
 * Single purpose: resolve {width, height} for a remote URL (or data URL) as
 * soon as the browser has decoded enough of the image to know its size. Used
 * for NIP-68 `annotate-user` center-coordinate computation and anywhere we
 * need the natural size before paint.
 *
 * @returns Promise that resolves to `{width, height}`, or `null` if the image
 *          fails to load / decode / is non-image.
 *
 * @example
 * const dim = await getImageDimensions('https://example.com/photo.jpg');
 * // => { width: 1024, height: 768 } | null
 */
export function getImageDimensions(
  url: string
): Promise<{ width: number; height: number } | null> {
  return new Promise(resolve => {
    if (!url || typeof url !== 'string') {
      resolve(null);
      return;
    }

    const img = new Image();
    let settled = false;

    const finish = (result: { width: number; height: number } | null) => {
      if (settled) return;
      settled = true;
      // Clear callbacks to avoid lingering references
      img.onload = null;
      img.onerror = null;
      resolve(result);
    };

    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (w > 0 && h > 0) {
        finish({ width: w, height: h });
      } else {
        finish(null);
      }
    };
    img.onerror = () => finish(null);

    // Some browsers fire onload synchronously when src is set; assigning after
    // the handlers are attached avoids that race.
    img.src = url;

    // Safety net: if neither onload nor onerror fires within 5s, give up so
    // the caller never hangs. This happens for unreachable URLs behind
    // silently-stalled connections.
    setTimeout(() => finish(null), 5000);
  });
}
