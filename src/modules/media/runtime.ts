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
      uploadFiles: (files, onProgress) => svc?.uploadFiles(files, onProgress) as any ?? Promise.resolve([]),
      cancelUpload: () => svc?.cancelUpload(),
    };
  }
}

export default new MediaRuntime();
