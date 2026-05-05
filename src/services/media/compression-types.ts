/**
 * Pre-upload media compression — shared types and defaults.
 *
 * Storage: PerAccountLocalStorage under StorageKeys.MEDIA_COMPRESSION.
 * Implementation: src/services/media/MediaCompressionService.ts (lazy-loaded).
 * Wired into: src/services/MediaUploadService.ts uploadFile().
 */

export type CompressionQuality = 'low' | 'medium' | 'high' | 'ultra';
export type MaxResolution = 480 | 720 | 1080 | 0; // 0 = keep original

export interface VideoCompressionSettings {
  enabled: boolean;
  quality: CompressionQuality;
  maxResolution: MaxResolution;
}

export interface AudioCompressionSettings {
  enabled: boolean;
  quality: CompressionQuality;
}

export interface MediaCompressionSettings {
  video: VideoCompressionSettings;
  audio: AudioCompressionSettings;
  minSizeBytes: number;
}

export const DEFAULT_MEDIA_COMPRESSION_SETTINGS: MediaCompressionSettings = {
  video: {
    enabled: true,
    quality: 'medium',
    maxResolution: 1080,
  },
  audio: {
    enabled: true,
    quality: 'medium',
  },
  minSizeBytes: 5 * 1024 * 1024,
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
