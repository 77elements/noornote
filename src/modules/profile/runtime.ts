import type { ModuleRuntime, ModuleContext } from '../../core/ModuleLoader';
import type { ProfileModuleApi } from './contracts';

export class ProfileRuntime implements ModuleRuntime<ProfileModuleApi> {
  private orchestrator: import('../../services/orchestration/ProfileOrchestrator').ProfileOrchestrator | null = null;

  async init(_ctx: ModuleContext): Promise<void> {
    const { ProfileOrchestrator } = await import('../../services/orchestration/ProfileOrchestrator');
    this.orchestrator = ProfileOrchestrator.getInstance();
  }

  async destroy(): Promise<void> {
    this.orchestrator = null;
  }

  getApi(): ProfileModuleApi {
    const orch = this.orchestrator;
    return {
      fetchProfile: (pubkey) => orch?.fetchProfile(pubkey) ?? Promise.resolve(null),
      fetchMultipleProfiles: (pubkeys) => orch?.fetchMultipleProfiles(pubkeys) ?? Promise.resolve(new Map()),
      fetchOldestEvent: (pubkey) => orch?.fetchOldestEvent(pubkey) ?? Promise.resolve(null),
    };
  }
}

export default new ProfileRuntime();
