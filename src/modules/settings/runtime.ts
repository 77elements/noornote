import type { ModuleRuntime, ModuleContext } from '../../core/ModuleLoader';
import type { SettingsModuleApi } from './contracts';

export class SettingsRuntime implements ModuleRuntime<SettingsModuleApi> {
  async init(_ctx: ModuleContext): Promise<void> {
    // Settings views are lazy-loaded by ViewMountingService on navigation.
    // No service initialization needed.
  }

  async destroy(): Promise<void> {
    // Nothing to clean up — views are managed by ViewMountingService.
  }

  getApi(): SettingsModuleApi {
    return {};
  }
}

export default new SettingsRuntime();
