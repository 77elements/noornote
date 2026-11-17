import type { VideoOptions, PictureOptions } from '../../services/VideoService';

export type { VideoOptions, PictureOptions };

export interface MediaUploadResult {
  success: boolean;
  url?: string;
  error?: string;
}

export interface MediaModuleApi {
  uploadFile(
    file: File,
    onProgress?: (progress: number) => void
  ): Promise<MediaUploadResult>;
  uploadFiles(
    files: File[],
    onProgress?: (progress: number) => void
  ): Promise<MediaUploadResult[]>;
  cancelUpload(): void;

  // VideoService
  publishVideo(options: VideoOptions): Promise<string | null>;
  publishPicture(options: PictureOptions): Promise<string | null>;
}
