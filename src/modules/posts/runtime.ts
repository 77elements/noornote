import type { ModuleRuntime, ModuleContext } from '../../core/ModuleLoader';
import type { PostsModuleApi } from './contracts';

export class PostsRuntime implements ModuleRuntime<PostsModuleApi> {
  private service: import('../../services/PostService').PostService | null = null;
  private noteService: import('../../services/NoteService').NoteService | null = null;

  async init(_ctx: ModuleContext): Promise<void> {
    const [postMod, noteMod] = await Promise.all([
      import('../../services/PostService'),
      import('../../services/NoteService'),
    ]);
    this.service = postMod.PostService.getInstance();
    this.noteService = noteMod.NoteService.getInstance();
  }

  async destroy(): Promise<void> {
    this.service = null;
    this.noteService = null;
  }

  getApi(): PostsModuleApi {
    const svc = this.service;
    const ns = this.noteService;
    return {
      createPost: (options) => svc?.createPost(options) ?? Promise.resolve(false),
      createReply: (options) => svc?.createReply(options) ?? Promise.resolve(null),
      createHighlight: (options) => svc?.createHighlight(options) ?? Promise.resolve(false),
      getNote: (eventId) => ns?.getNote(eventId) ?? Promise.resolve(null),
      getNotes: (eventIds) => ns?.getNotes(eventIds) ?? Promise.resolve(new Map()),
      getCachedNote: (eventId) => ns?.getCachedNote(eventId) ?? null,
      registerNote: (event) => ns?.registerNote(event),
      registerNotes: (events) => ns?.registerNotes(events),
      hasNote: (eventId) => ns?.hasNote(eventId) ?? false,
    };
  }
}

export default new PostsRuntime();
