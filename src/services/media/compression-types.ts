/**
 * Pre-upload media compression — shared types and defaults.
 *
 * Storage: PerAccountLocalStorage under StorageKeys.MEDIA_COMPRESSION.
 * Implementation: src/services/media/MediaCompressionService.ts (lazy-loaded).
 * Wired into: src/services/MediaUploadService.ts uploadFile().
 */

export type CompressionQuality = 'low' | 'medium' | 'high' | 'ultra';
export type MaxResolution = 480 | 720 | 1024 | 1080 | 1280 | 0; // 0 = keep original

export interface VideoCompressionSettings {
  enabled: boolean;
  quality: CompressionQuality;
  maxResolution: MaxResolution;
  /** Files below this size are uploaded as-is. */
  minSizeBytes: number;
}

export interface AudioCompressionSettings {
  enabled: boolean;
  quality: CompressionQuality;
  /** Files below this size are uploaded as-is. */
  minSizeBytes: number;
}

export interface ImageCompressionSettings {
  enabled: boolean;
  quality: CompressionQuality;
  maxResolution: MaxResolution;
  /** Files below this size are uploaded as-is. */
  minSizeBytes: number;
  /** GPS block + Artist/Copyright/owner/serial/Windows-XP/ImageUniqueID. */
  stripExifCritical: boolean;
  /** DateTime, OffsetTime, SubSecTime variants + MakerNote. */
  stripExifMedium: boolean;
  /** Make/Model, LensMake/LensModel, Software, HostComputer. */
  stripExifWeak: boolean;
}

export interface MediaCompressionSettings {
  image: ImageCompressionSettings;
  video: VideoCompressionSettings;
  audio: AudioCompressionSettings;
}

export const DEFAULT_MEDIA_COMPRESSION_SETTINGS: MediaCompressionSettings = {
  image: {
    enabled: true,
    quality: 'high',
    maxResolution: 1280,
    minSizeBytes: 100 * 1024, // 100 KB
    stripExifCritical: false,
    stripExifMedium: false,
    stripExifWeak: false,
  },
  video: {
    enabled: true,
    quality: 'medium',
    maxResolution: 1080,
    minSizeBytes: 5 * 1024 * 1024, // 5 MB
  },
  audio: {
    enabled: true,
    quality: 'medium',
    minSizeBytes: 2 * 1024 * 1024, // 2 MB
  },
};

/** JPEG quality factor (0..1) per preset. */
export const IMAGE_JPEG_QUALITY: Record<CompressionQuality, number> = {
  low:    0.5,
  medium: 0.7,
  high:   0.85,
  ultra:  0.95,
};

// Bitrate per audio quality preset, in kbps.
export const AUDIO_BITRATE_KBPS: Record<CompressionQuality, number> = {
  low: 64,
  medium: 128,
  high: 192,
  ultra: 256,
};

export type UploadPhase = 'compressing' | 'compressed' | 'uploading' | 'uploaded';

export type MediaKind = 'video' | 'audio' | 'image' | 'other';

export interface UploadStatus {
  phase: UploadPhase;
  percent: number;
  mediaKind: MediaKind;
  filename: string;
  // Populated after the 'compressed' phase fires.
  originalBytes?: number | undefined;
  compressedBytes?: number | undefined;
  // For batch uploads (uploadFiles): index/count of the current file.
  fileIndex?: number | undefined;
  totalFiles?: number | undefined;
}

export function detectMediaKind(file: File): MediaKind {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('image/')) return 'image';
  return 'other';
}
