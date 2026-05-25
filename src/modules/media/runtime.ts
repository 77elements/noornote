import type { ModuleRuntime, ModuleContext } from '../../core/ModuleLoader';
import type { MediaModuleApi } from './contracts';

export class MediaRuntime implements ModuleRuntime<MediaModuleApi> {
  private service: import('../../services/MediaUploadService').MediaUploadService | null = null;

  async init(_ctx: ModuleContext): Promise<void> {
    const { MediaUploadService } = await import('../../services/MediaUploadService');
    this.service = MediaUploadService.getInstance();
  }

  async destroy(): Promise<void> {
    this.service = null;
  }

  getApi(): MediaModuleApi {
    const svc = this.service;
    return {
      uploadFile: (file, onProgress) => svc?.uploadFile(file, onProgress) as any ?? Promise.resolve({ success: false, error: 'Module not loaded' }),
      uploadFiles: (files, onProgress) => {
        if (!svc) return Promise.resolve([]);
        // Wrap the single-number contract callback into the 3-arg internal format
        const internalCb = onProgress
          ? (fileIndex: number, progress: number, totalFiles: number) => {
              const overall = (fileIndex / totalFiles) * 100 + (progress / totalFiles);
              onProgress(Math.min(overall, 99));
            }
          : undefined;
        return svc.uploadFiles(files, internalCb);
      },
      cancelUpload: () => svc?.cancelUpload(),
    };
  }
}

export default new MediaRuntime();
