import type { ModuleRuntime, ModuleContext } from '../../core/ModuleLoader';
import type { PostsModuleApi } from './contracts';

export class PostsRuntime implements ModuleRuntime<PostsModuleApi> {
  private service: import('../../services/PostService').PostService | null = null;

  async init(_ctx: ModuleContext): Promise<void> {
    const { PostService } = await import('../../services/PostService');
    this.service = PostService.getInstance();
  }

  async destroy(): Promise<void> {
    this.service = null;
  }

  getApi(): PostsModuleApi {
    const svc = this.service;
    return {
      createPost: (options) => svc?.createPost(options) ?? Promise.resolve(false),
      createReply: (options) => svc?.createReply(options) ?? Promise.resolve(null),
      createHighlight: (options) => svc?.createHighlight(options) ?? Promise.resolve(false),
    };
  }
}

export default new PostsRuntime();
