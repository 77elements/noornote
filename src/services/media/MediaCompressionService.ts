/**
 * MediaCompressionService
 *
 * Pre-upload media compression using WebCodecs via mediabunny.
 * - Video: ported from nostr-compress (HEVC/AV1/VP9/AVC auto-select).
 * - Audio: AAC/MP3/Opus output depending on input.
 *
 * Heavy mediabunny dependency lives only in this file. The whole service is
 * lazy-loaded from MediaUploadService via dynamic import — its own Rollup
 * chunk, fetched only when the first video/audio upload happens in a session.
 */

import {
  Input,
  Output,
  Conversion,
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Mp4OutputFormat,
  WebMOutputFormat,
  Mp3OutputFormat,
  OggOutputFormat,
  type OutputFormat,
  getEncodableVideoCodecs,
  getEncodableAudioCodecs,
} from 'mediabunny';

// OffscreenCanvas resize+encode worker. ?worker&inline base64-embeds it so it
// also loads under file:// (Electron/Capacitor).
import ImageResizeWorker from './imageResize.worker?worker&inline';
import { PlatformService } from '../PlatformService';
import {
  AUDIO_BITRATE_KBPS,
  IMAGE_JPEG_QUALITY,
  type AudioCompressionSettings,
  type CompressionQuality,
  type ImageCompressionSettings,
  type VideoCompressionSettings,
} from './compression-types';

type ProgressCallback = (percent: number) => void;

// ---------------------------------------------------------------------------
// Video — quality presets and BPP map (taken from nostr-compress)
// ---------------------------------------------------------------------------

// Bits Per Pixel — calibrated lower than nostr-compress's defaults so that
// even when the source bitrate is unknown, "medium" produces a genuinely
// smaller file. Real-world cap is enforced separately via SOURCE_BITRATE_CAP.
const VIDEO_BPP_MAP: Record<CompressionQuality, number> = {
  low: 0.06,
  medium: 0.12,
  high: 0.2,
  ultra: 0.35,
};

// Target may be at most this fraction of the source bitrate. Guarantees a
// meaningful size reduction even when the source is already well-compressed
// (typical phone videos are ~10-13 Mbps at 1080p — close to the BPP target).
const SOURCE_BITRATE_CAP = 0.7;

interface VideoCodecChoice {
  codec: 'hevc' | 'av1' | 'vp9' | 'avc';
  format: 'mp4' | 'webm';
}

async function pickVideoCodec(): Promise<VideoCodecChoice | null> {
  const codecs = await getEncodableVideoCodecs();
  // Prefer mp4-container codecs (HEVC, AVC) over webm-container codecs (AV1, VP9)
  // — most source videos are mp4 and users expect mp4 output. On Electron, GPU
  // is disabled and HEVC software encoder isn't available in Chromium → AVC
  // wins, output stays mp4.
  if (codecs.includes('hevc')) return { codec: 'hevc', format: 'mp4' };
  if (codecs.includes('avc')) return { codec: 'avc', format: 'mp4' };
  if (codecs.includes('av1')) return { codec: 'av1', format: 'webm' };
  if (codecs.includes('vp9')) return { codec: 'vp9', format: 'webm' };
  return null;
}

// ---------------------------------------------------------------------------
// Audio — output format selection by input MIME / extension
// ---------------------------------------------------------------------------

interface AudioCodecChoice {
  codec: 'aac' | 'mp3' | 'opus';
  output: OutputFormat;
  mimeType: string;
  extension: string;
}

async function pickAudioCodec(file: File): Promise<AudioCodecChoice | null> {
  const codecs = await getEncodableAudioCodecs();
  const lcName = file.name.toLowerCase();
  const mime = file.type.toLowerCase();

  // Prefer a codec/container similar to the input. Fall back to AAC for
  // formats that would not benefit from re-encoding to themselves (WAV/FLAC).
  const wantsMp3 =
    mime.includes('mpeg') || mime.includes('mp3') || lcName.endsWith('.mp3');
  const wantsOpus =
    mime.includes('opus') ||
    mime.includes('ogg') ||
    lcName.endsWith('.opus') ||
    lcName.endsWith('.ogg');

  if (wantsMp3 && codecs.includes('mp3')) {
    return {
      codec: 'mp3',
      output: new Mp3OutputFormat(),
      mimeType: 'audio/mpeg',
      extension: 'mp3',
    };
  }
  if (wantsOpus && codecs.includes('opus')) {
    return {
      codec: 'opus',
      output: new OggOutputFormat(),
      mimeType: 'audio/ogg',
      extension: 'ogg',
    };
  }
  if (codecs.includes('aac')) {
    return {
      codec: 'aac',
      output: new Mp4OutputFormat(),
      mimeType: 'audio/mp4',
      extension: 'm4a',
    };
  }
  if (codecs.includes('opus')) {
    return {
      codec: 'opus',
      output: new OggOutputFormat(),
      mimeType: 'audio/ogg',
      extension: 'ogg',
    };
  }
  if (codecs.includes('mp3')) {
    return {
      codec: 'mp3',
      output: new Mp3OutputFormat(),
      mimeType: 'audio/mpeg',
      extension: 'mp3',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public service
// ---------------------------------------------------------------------------

export class MediaCompressionService {
  /** True if at least one usable video codec is encodable in this browser. */
  static async isVideoSupported(): Promise<boolean> {
    return (await pickVideoCodec()) !== null;
  }

  /** True if at least one usable audio codec is encodable in this browser. */
  static async isAudioSupported(): Promise<boolean> {
    return (await getEncodableAudioCodecs()).length > 0;
  }

  /** Image compression uses Canvas + `canvas.toBlob('image/jpeg')`, which
   *  is universally available in every supported runtime. */
  static async isImageSupported(): Promise<boolean> {
    return (
      typeof document !== 'undefined' &&
      typeof HTMLCanvasElement !== 'undefined'
    );
  }

  /**
   * Compress an image by resizing to the configured max dimension and
   * re-encoding in the source format: PNG → PNG (lossless, transparency
   * preserved), JPEG → JPEG at the configured quality with EXIF copied
   * via piexifjs. Other formats (WebP/GIF/AVIF/...) fall back to JPEG.
   */
  static async compressImage(
    file: File,
    settings: ImageCompressionSettings,
    onProgress: ProgressCallback
  ): Promise<File> {
    onProgress(5);

    const isPng = file.type === 'image/png';
    const isJpeg = file.type === 'image/jpeg';
    const outputMime = isPng ? 'image/png' : 'image/jpeg';
    const outputExt = isPng ? '.png' : '.jpg';
    // PNG ignores quality; JPEG/WebP honor it.
    const quality = isPng
      ? undefined
      : (IMAGE_JPEG_QUALITY[settings.quality] ?? IMAGE_JPEG_QUALITY.high);

    // Resize + re-encode off the main thread (OffscreenCanvas worker) so a large
    // photo doesn't freeze the UI. Fall back to the main-thread canvas path when
    // the worker / OffscreenCanvas is unavailable or fails.
    let blob: Blob | null = null;
    if (canUseImageWorker()) {
      try {
        blob = await resizeEncodeInWorker(
          file,
          settings.maxResolution,
          outputMime,
          quality
        );
        onProgress(60);
      } catch (err) {
        console.debug('Image resize worker failed, using main thread:', err);
        blob = null;
      }
    }
    if (!blob) {
      blob = await resizeEncodeMainThread(
        file,
        settings.maxResolution,
        outputMime,
        quality,
        onProgress
      );
    }
    onProgress(80);

    // Restore EXIF for JPEG sources, optionally stripping privacy categories.
    // Skipped silently when piexifjs fails or there's no EXIF to copy — the
    // compressed JPEG is still valid.
    if (isJpeg) {
      try {
        blob = await transferExif(file, blob, {
          critical: settings.stripExifCritical,
          medium: settings.stripExifMedium,
          weak: settings.stripExifWeak,
        });
      } catch (err) {
        // Don't fail compression because EXIF transfer choked.
        console.debug('Failed to preserve EXIF, dropping metadata:', err);
      }
    }

    onProgress(100);

    const baseName = file.name.replace(/\.[^.]+$/, '') || 'image';
    return new File([blob], `${baseName}${outputExt}`, { type: outputMime });
  }

  /**
   * Compress a video file. Returns a new File with the same base name but the
   * codec-appropriate extension. Throws if compression cannot be set up.
   */
  static async compressVideo(
    file: File,
    settings: VideoCompressionSettings,
    onProgress: ProgressCallback
  ): Promise<File> {
    const choice = await pickVideoCodec();
    if (!choice)
      throw new Error('No encodable video codec available in this browser');

    const input = new Input({
      formats: ALL_FORMATS,
      source: new BlobSource(file),
    });

    // Resolution: clamp to source if maxResolution=0 (original) or source is smaller.
    let targetWidth: number;
    let sourceBitrate: number | null = null;
    try {
      const track = await input.getPrimaryVideoTrack();
      const sourceWidth = track ? await track.getDisplayWidth() : 1920;
      const desired =
        settings.maxResolution === 0 ? sourceWidth : settings.maxResolution;
      // Map the desired height-bucket to an approximate width (assume 16:9).
      const desiredWidth =
        settings.maxResolution === 0
          ? sourceWidth
          : Math.round(desired * (16 / 9));
      targetWidth = Math.min(sourceWidth, desiredWidth);
      // Best-effort read of source bitrate — used to cap target so we always
      // achieve real compression. Container may not expose it (returns null).
      if (track) {
        sourceBitrate =
          (await track.getAverageBitrate()) ?? (await track.getBitrate());
      }
    } catch {
      targetWidth =
        settings.maxResolution === 0
          ? 1920
          : Math.round(settings.maxResolution * (16 / 9));
    }
    const targetHeight = Math.round(targetWidth * (9 / 16));
    const estimatedFps = 30;
    const bppBitrate = Math.round(
      targetWidth *
        targetHeight *
        estimatedFps *
        VIDEO_BPP_MAP[settings.quality]
    );
    // Cap to a fraction of source bitrate when known, so we always come out
    // smaller than the input even if it's already heavily compressed.
    const targetBitrate = sourceBitrate
      ? Math.min(bppBitrate, Math.round(sourceBitrate * SOURCE_BITRATE_CAP))
      : bppBitrate;

    const outputFormat: OutputFormat =
      choice.format === 'webm' ? new WebMOutputFormat() : new Mp4OutputFormat();
    const output = new Output({
      format: outputFormat,
      target: new BufferTarget(),
    });

    const conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      video: {
        width: targetWidth,
        bitrate: targetBitrate,
        codec: choice.codec,
        // Electron disables the GPU process (electron/main/index.js calls
        // app.disableHardwareAcceleration()), so the WebCodecs hardware video
        // encoder isn't available there — we MUST use software. Web/Capacitor
        // have GPU, so hardware is preferred (much faster). Ultra always
        // prefers software for quality regardless of platform.
        hardwareAcceleration:
          PlatformService.getInstance().isElectron ||
          settings.quality === 'ultra'
            ? 'prefer-software'
            : 'prefer-hardware',
        keyFrameInterval: 2,
      },
      audio: {
        bitrate: AUDIO_BITRATE_KBPS.medium * 1000,
      },
      tags: {},
    });

    if (!conversion.isValid) {
      throw new Error('Video conversion is not valid for this file');
    }

    conversion.onProgress = p => onProgress(p * 100);
    await conversion.execute();

    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer) throw new Error('Video compression produced empty output');

    const mimeType = choice.format === 'webm' ? 'video/webm' : 'video/mp4';
    const extension = choice.format === 'webm' ? 'webm' : 'mp4';
    const baseName = stripExtension(file.name);
    return new File([buffer], `${baseName}.${extension}`, { type: mimeType });
  }

  /**
   * Compress an audio file. Returns a new File with the codec-appropriate
   * extension. Throws if compression cannot be set up.
   */
  static async compressAudio(
    file: File,
    settings: AudioCompressionSettings,
    onProgress: ProgressCallback
  ): Promise<File> {
    const choice = await pickAudioCodec(file);
    if (!choice)
      throw new Error('No encodable audio codec available in this browser');

    const input = new Input({
      formats: ALL_FORMATS,
      source: new BlobSource(file),
    });
    const output = new Output({
      format: choice.output,
      target: new BufferTarget(),
    });

    // Read source bitrate to cap our target (same logic as video).
    let sourceBitrate: number | null = null;
    try {
      const track = await input.getPrimaryAudioTrack();
      if (track)
        sourceBitrate =
          (await track.getAverageBitrate()) ?? (await track.getBitrate());
    } catch {
      /* container may not expose bitrate */
    }

    const presetBitrate = AUDIO_BITRATE_KBPS[settings.quality] * 1000;
    const targetBitrate = sourceBitrate
      ? Math.min(presetBitrate, Math.round(sourceBitrate * SOURCE_BITRATE_CAP))
      : presetBitrate;

    const conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      audio: {
        codec: choice.codec,
        bitrate: targetBitrate,
      },
      tags: {},
    });

    if (!conversion.isValid) {
      throw new Error('Audio conversion is not valid for this file');
    }

    conversion.onProgress = p => onProgress(p * 100);
    await conversion.execute();

    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer) throw new Error('Audio compression produced empty output');

    const baseName = stripExtension(file.name);
    return new File([buffer], `${baseName}.${choice.extension}`, {
      type: choice.mimeType,
    });
  }
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** EXIF tag IDs (decimal) per privacy category. The "keep" set (Orientation,
 *  Resolution, ColorSpace, ICC, dimensions, version headers) is everything NOT
 *  listed here — we only delete what's enumerated. */
const STRIP_CRITICAL_0TH = [315, 33432, 40091, 40092, 40093, 40094, 40095];
// Artist, Copyright, XPTitle, XPComment, XPAuthor, XPKeywords, XPSubject
const STRIP_CRITICAL_EXIF = [42016, 42032, 42033, 42037];
// ImageUniqueID, CameraOwnerName, BodySerialNumber, LensSerialNumber
const STRIP_MEDIUM_0TH = [306]; // DateTime
const STRIP_MEDIUM_EXIF = [
  36867,
  36868, // DateTimeOriginal, DateTimeDigitized
  36880,
  36881,
  36882, // OffsetTime, OffsetTimeOriginal, OffsetTimeDigitized
  37520,
  37521,
  37522, // SubSecTime, SubSecTimeOriginal, SubSecTimeDigitized
  37500, // MakerNote
];
const STRIP_WEAK_0TH = [271, 272, 305, 316]; // Make, Model, Software, HostComputer
const STRIP_WEAK_EXIF = [42035, 42036]; // LensMake, LensModel

interface ExifStripOptions {
  critical: boolean;
  medium: boolean;
  weak: boolean;
}

type ExifIfd = Record<number, unknown> | undefined;
type ExifObj = Record<string, ExifIfd | string | undefined>;

function deleteFromIfd(ifd: ExifIfd, tagIds: number[]): void {
  if (!ifd) return;
  for (const id of tagIds) delete ifd[id];
}

function applyExifStrip(exifObj: ExifObj, opts: ExifStripOptions): void {
  if (opts.critical) {
    delete exifObj.GPS;
    deleteFromIfd(exifObj['0th'] as ExifIfd, STRIP_CRITICAL_0TH);
    deleteFromIfd(exifObj.Exif as ExifIfd, STRIP_CRITICAL_EXIF);
  }
  if (opts.medium) {
    deleteFromIfd(exifObj['0th'] as ExifIfd, STRIP_MEDIUM_0TH);
    deleteFromIfd(exifObj.Exif as ExifIfd, STRIP_MEDIUM_EXIF);
  }
  if (opts.weak) {
    deleteFromIfd(exifObj['0th'] as ExifIfd, STRIP_WEAK_0TH);
    deleteFromIfd(exifObj.Exif as ExifIfd, STRIP_WEAK_EXIF);
  }
}

/** Whether the OffscreenCanvas image worker can run in this runtime. */
function canUseImageWorker(): boolean {
  return (
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof createImageBitmap === 'function'
  );
}

/** Resize + re-encode an image off the main thread via the OffscreenCanvas
 *  worker. Spins up a one-shot worker, transfers the bytes in and out, then
 *  terminates it. Rejects on any worker error so the caller can fall back. */
async function resizeEncodeInWorker(
  file: File,
  maxResolution: number,
  outputMime: string,
  quality: number | undefined
): Promise<Blob> {
  const buf = await file.arrayBuffer();
  return new Promise<Blob>((resolve, reject) => {
    const worker = new ImageResizeWorker();
    worker.onmessage = (e: MessageEvent) => {
      const data = e.data as { ok: boolean; buf?: ArrayBuffer; error?: string };
      worker.terminate();
      if (data.ok && data.buf)
        resolve(new Blob([data.buf], { type: outputMime }));
      else reject(new Error(data.error || 'Image worker resize failed'));
    };
    worker.onerror = (err: ErrorEvent) => {
      worker.terminate();
      reject(new Error(err.message || 'Image worker error'));
    };
    worker.postMessage(
      { buf, type: file.type, maxResolution, outputMime, quality },
      [buf]
    );
  });
}

/** Main-thread fallback: decode via <img>, resize on a <canvas>, encode via
 *  canvas.toBlob. Used when the OffscreenCanvas worker is unavailable or fails. */
async function resizeEncodeMainThread(
  file: File,
  maxResolution: number,
  outputMime: string,
  quality: number | undefined,
  onProgress: ProgressCallback
): Promise<Blob> {
  const sourceUrl = URL.createObjectURL(file);
  const img = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Image decode failed'));
      img.src = sourceUrl;
    });
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
  onProgress(25);

  // Target dimensions preserving aspect ratio.
  const maxDim =
    maxResolution > 0 ? maxResolution : Math.max(img.width, img.height);
  let targetW = img.width;
  let targetH = img.height;
  if (img.width > maxDim || img.height > maxDim) {
    if (img.width >= img.height) {
      targetW = maxDim;
      targetH = Math.round(img.height * (maxDim / img.width));
    } else {
      targetH = maxDim;
      targetW = Math.round(img.width * (maxDim / img.height));
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(img, 0, 0, targetW, targetH);
  onProgress(60);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      b => (b ? resolve(b) : reject(new Error('Canvas toBlob failed'))),
      outputMime,
      quality
    );
  });
}

/** Copy EXIF from a JPEG source onto a (canvas-encoded) JPEG blob, optionally
 *  stripping privacy-relevant tag groups. piexifjs works on data-URLs so we
 *  round-trip via FileReader. The library is loaded on-demand because EXIF
 *  preservation only matters for JPEG inputs. */
async function transferExif(
  source: File,
  encoded: Blob,
  strip: ExifStripOptions
): Promise<Blob> {
  const piexif = (await import('piexifjs')) as typeof import('piexifjs');
  const sourceUrl = await blobToDataUrl(source);
  const exifObj = piexif.load(sourceUrl) as ExifObj;
  applyExifStrip(exifObj, strip);
  const exifBin = piexif.dump(exifObj as Record<string, unknown>);
  if (!exifBin) return encoded; // No EXIF in source — nothing to transfer.
  const encodedUrl = await blobToDataUrl(encoded);
  const merged = piexif.insert(exifBin, encodedUrl);
  const res = await fetch(merged);
  return await res.blob();
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () =>
      reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}
