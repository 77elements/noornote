import type { ModuleRuntime, ModuleContext } from '../../core/ModuleLoader';
import type { SearchModuleApi } from './contracts';

export class SearchRuntime implements ModuleRuntime<SearchModuleApi> {
  private orchestrator: import('../../services/orchestration/SearchOrchestrator').SearchOrchestrator | null = null;
  private userSearchService: import('../../services/UserSearchService').UserSearchService | null = null;

  async init(_ctx: ModuleContext): Promise<void> {
    const [orchMod, userSearchMod] = await Promise.all([
      import('../../services/orchestration/SearchOrchestrator'),
      import('../../services/UserSearchService'),
    ]);
    this.orchestrator = orchMod.SearchOrchestrator.getInstance();
    this.userSearchService = userSearchMod.UserSearchService.getInstance();
  }

  async destroy(): Promise<void> {
    this.orchestrator = null;
    this.userSearchService = null;
  }

  getApi(): SearchModuleApi {
    const orch = this.orchestrator;
    const uss = this.userSearchService;
    return {
      search: (options) => orch?.search(options) ?? Promise.resolve([]),
      searchPaginated: (options, until) => orch?.searchPaginated(options, until) ?? Promise.resolve([]),
      searchProfiles: (query, limit) => orch?.searchProfiles(query, limit) ?? Promise.resolve([]),
      searchUsers: (query, callbacks) => uss?.search(query, callbacks) ?? new AbortController(),
    };
  }
}

export default new SearchRuntime();
