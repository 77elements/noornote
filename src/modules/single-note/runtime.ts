import type { ModuleRuntime, ModuleContext } from '../../core/ModuleLoader';
import type { SingleNoteModuleApi } from './contracts';

export class SingleNoteRuntime implements ModuleRuntime<SingleNoteModuleApi> {
  private orchestrator: import('../../services/orchestration/ThreadOrchestrator').ThreadOrchestrator | null = null;

  async init(_ctx: ModuleContext): Promise<void> {
    const { ThreadOrchestrator } = await import('../../services/orchestration/ThreadOrchestrator');
    this.orchestrator = ThreadOrchestrator.getInstance();
  }

  async destroy(): Promise<void> {
    this.orchestrator = null;
  }

  getApi(): SingleNoteModuleApi {
    const orch = this.orchestrator;
    return {
      fetchReplies: (noteId) => orch?.fetchReplies(noteId) ?? Promise.resolve([]),
      fetchParentChain: (noteId) => orch?.fetchParentChain(noteId) ?? Promise.resolve({ items: [], rootId: null } as any),
      startLiveReplies: (noteId, callback) => orch?.startLiveReplies(noteId, callback),
      stopLiveReplies: (noteId) => orch?.stopLiveReplies(noteId),
      clearCache: (noteId) => orch?.clearCache(noteId),
    };
  }
}

export default new SingleNoteRuntime();
