export interface MediaUploadResult {
  success: boolean;
  url?: string;
  error?: string;
}

export interface MediaModuleApi {
  uploadFile(file: File, onProgress?: (progress: number) => void): Promise<MediaUploadResult>;
  uploadFiles(files: File[], onProgress?: (progress: number) => void): Promise<MediaUploadResult[]>;
  cancelUpload(): void;
}
