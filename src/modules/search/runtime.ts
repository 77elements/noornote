import type { ModuleRuntime, ModuleContext } from '../../core/ModuleLoader';
import type { SearchModuleApi } from './contracts';

export class SearchRuntime implements ModuleRuntime<SearchModuleApi> {
  private orchestrator: import('../../services/orchestration/SearchOrchestrator').SearchOrchestrator | null = null;

  async init(_ctx: ModuleContext): Promise<void> {
    const { SearchOrchestrator } = await import('../../services/orchestration/SearchOrchestrator');
    this.orchestrator = SearchOrchestrator.getInstance();
  }

  async destroy(): Promise<void> {
    this.orchestrator = null;
  }

  getApi(): SearchModuleApi {
    const orch = this.orchestrator;
    return {
      search: (options) => orch?.search(options) ?? Promise.resolve([]),
      searchPaginated: (options) => orch?.searchPaginated(options) ?? Promise.resolve([]),
      searchProfiles: (query, limit) => orch?.searchProfiles(query, limit) ?? Promise.resolve([]),
    };
  }
}

export default new SearchRuntime();
