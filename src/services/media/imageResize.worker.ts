/**
 * Image resize + re-encode worker.
 *
 * Runs the heavy part of image compression (decode → resize → encode) off the
 * main thread via OffscreenCanvas + createImageBitmap, so a large photo upload
 * never freezes the UI. Self-contained (no imports) so `?worker&inline` keeps
 * it tiny and it loads under file:// (Electron/Capacitor).
 *
 * Protocol:
 *   in : { buf: ArrayBuffer, type, maxResolution, outputMime, quality? }
 *   out: { ok: true, buf: ArrayBuffer } | { ok: false, error: string }
 */

interface ResizeRequest {
  buf: ArrayBuffer;
  type: string;
  maxResolution: number;
  outputMime: string;
  quality?: number;
}

// Minimal worker-scope shape (avoids needing the WebWorker TS lib / `any`).
type WorkerCtx = {
  onmessage: ((e: MessageEvent<ResizeRequest>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};
const ctx = self as unknown as WorkerCtx;

ctx.onmessage = (e: MessageEvent<ResizeRequest>): void => {
  const { buf, type, maxResolution, outputMime, quality } = e.data;
  void (async () => {
    try {
      const bitmap = await createImageBitmap(new Blob([buf], { type }));

      // Target dimensions preserving aspect ratio (mirrors the main-thread path).
      const maxDim =
        maxResolution > 0
          ? maxResolution
          : Math.max(bitmap.width, bitmap.height);
      let targetW = bitmap.width;
      let targetH = bitmap.height;
      if (bitmap.width > maxDim || bitmap.height > maxDim) {
        if (bitmap.width >= bitmap.height) {
          targetW = maxDim;
          targetH = Math.round(bitmap.height * (maxDim / bitmap.width));
        } else {
          targetH = maxDim;
          targetW = Math.round(bitmap.width * (maxDim / bitmap.height));
        }
      }

      const canvas = new OffscreenCanvas(targetW, targetH);
      const c2d = canvas.getContext('2d');
      if (!c2d) throw new Error('OffscreenCanvas 2D context unavailable');
      c2d.drawImage(bitmap, 0, 0, targetW, targetH);
      bitmap.close();

      // convertToBlob honors `quality` for image/jpeg + image/webp, ignores it for png.
      const opts: ImageEncodeOptions =
        quality === undefined
          ? { type: outputMime }
          : { type: outputMime, quality };
      const blob = await canvas.convertToBlob(opts);
      const outBuf = await blob.arrayBuffer();
      ctx.postMessage({ ok: true, buf: outBuf }, [outBuf]);
    } catch (err) {
      ctx.postMessage({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
};
