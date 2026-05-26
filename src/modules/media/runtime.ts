import type { ModuleRuntime, ModuleContext } from '../../core/ModuleLoader';
import type { MediaModuleApi } from './contracts';

export class MediaRuntime implements ModuleRuntime<MediaModuleApi> {
  private service: import('../../services/MediaUploadService').MediaUploadService | null = null;
  private videoService: import('../../services/VideoService').VideoService | null = null;

  async init(_ctx: ModuleContext): Promise<void> {
    const [uploadMod, videoMod] = await Promise.all([
      import('../../services/MediaUploadService'),
      import('../../services/VideoService'),
    ]);
    this.service = uploadMod.MediaUploadService.getInstance();
    this.videoService = videoMod.VideoService.getInstance();
  }

  async destroy(): Promise<void> {
    this.service = null;
    this.videoService = null;
  }

  getApi(): MediaModuleApi {
    const svc = this.service;
    const vs = this.videoService;
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
      publishVideo: (options) => vs?.publishVideo(options) ?? Promise.resolve(null),
    };
  }
}

export default new MediaRuntime();
