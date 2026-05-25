import type { ModuleRuntime, ModuleContext } from '../../core/ModuleLoader';
import type { RelayBrowserModuleApi } from './contracts';

export class RelayBrowserRuntime implements ModuleRuntime<RelayBrowserModuleApi> {
  private orchestrator: import('../../services/orchestration/RelayBrowserOrchestrator').RelayBrowserOrchestrator | null = null;

  async init(_ctx: ModuleContext): Promise<void> {
    const { RelayBrowserOrchestrator } = await import('../../services/orchestration/RelayBrowserOrchestrator');
    this.orchestrator = RelayBrowserOrchestrator.getInstance();
  }

  async destroy(): Promise<void> {
    this.orchestrator = null;
  }

  getApi(): RelayBrowserModuleApi {
    const orch = this.orchestrator;
    const emptyResult = { events: [], hasMore: false };
    return {
      setRelay: (url) => orch?.setRelay(url),
      loadInitial: () => orch?.loadInitial() ?? Promise.resolve(emptyResult),
      loadMore: () => orch?.loadMore() ?? Promise.resolve(emptyResult),
      pollNewNotes: () => orch?.pollNewNotes() ?? Promise.resolve([]),
    };
  }
}

export default new RelayBrowserRuntime();
