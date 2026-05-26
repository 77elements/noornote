import type { ModuleRuntime, ModuleContext } from '../../core/ModuleLoader';
import type { SettingsModuleApi } from './contracts';

export class SettingsRuntime implements ModuleRuntime<SettingsModuleApi> {
  private relayListOrch: import('../../services/orchestration/RelayListOrchestrator').RelayListOrchestrator | null = null;
  private RelayListOrchClass: typeof import('../../services/orchestration/RelayListOrchestrator').RelayListOrchestrator | null = null;
  private healthMonitor: import('../../services/RelayHealthMonitor').RelayHealthMonitor | null = null;
  private updateCheckService: import('../../services/UpdateCheckService').UpdateCheckService | null = null;

  async init(_ctx: ModuleContext): Promise<void> {
    const [relayListMod, healthMod, updateMod] = await Promise.all([
      import('../../services/orchestration/RelayListOrchestrator'),
      import('../../services/RelayHealthMonitor'),
      import('../../services/UpdateCheckService'),
    ]);
    this.RelayListOrchClass = relayListMod.RelayListOrchestrator;
    this.relayListOrch = relayListMod.RelayListOrchestrator.getInstance();
    this.healthMonitor = healthMod.RelayHealthMonitor.getInstance();
    this.updateCheckService = updateMod.UpdateCheckService.getInstance();
  }

  async destroy(): Promise<void> {
    this.relayListOrch = null;
    this.RelayListOrchClass = null;
    this.healthMonitor = null;
    this.updateCheckService = null;
  }

  getApi(): SettingsModuleApi {
    const rlo = this.relayListOrch;
    const RloCls = this.RelayListOrchClass;
    const hm = this.healthMonitor;
    const ucs = this.updateCheckService;
    return {
      fetchRelayList: (pubkey, bootstrapRelays) => rlo?.fetchRelayList(pubkey, bootstrapRelays) ?? Promise.resolve(null),
      publishRelayList: (relays, event) => rlo?.publishRelayList(relays, event) ?? Promise.resolve(),
      relayInfosToTags: (relays) => RloCls?.relayInfosToTags(relays) ?? [],
      getRelayHealthMetrics: (url) => hm?.getMetrics(url) ?? null,
      getHealthSummary: () => hm?.getHealthSummary() ?? Promise.resolve({ healthy: 0, total: 0, warnings: [] }),
      skipVersion: (version) => ucs?.skipVersion(version),
      isAutoCheckEnabled: () => ucs?.isAutoCheckEnabled() ?? false,
      setAutoCheckEnabled: (enabled) => ucs?.setAutoCheckEnabled(enabled),
      checkUpdateManually: (button) => ucs?.checkManually(button) ?? Promise.resolve(),
    };
  }
}

export default new SettingsRuntime();
