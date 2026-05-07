/**
 * NosPress addon runtime.
 *
 * Single static-import entry point for the NosPress editor stack. When the
 * addon is OFF, none of this code is in the bundle/RAM — AddonLoader only
 * pulls this module in via the registerAddons.ts dynamic-import factory,
 * which gives rollup a chunk boundary around everything reachable from
 * here.
 *
 * Scope: this runtime is for the OWNER's editor side (the `/nospress`
 * fullscreen editor). The public-page renderer (`PublicNospressPage`)
 * lives in its own dynamic chunk loaded by `PublicPageBootstrap` whenever
 * a visitor lands on a `noornote.app/{handle}/` URL — the visitor's own
 * NosPress toggle is irrelevant for that path. Some services + orchestrators
 * are shared between the two; rollup hoists them into a common chunk.
 *
 * Init: warm the 10 NosPress singletons so the first editor interaction
 * doesn't pay constructor cost. Each constructor is side-effect-free
 * (only stores collaborator refs); no relay traffic happens here.
 *
 * Destroy contract:
 *   - removeUserCss() takes down the `<style id="user-site-custom-css">`
 *     tag so user CSS cannot leak into other views after toggle-OFF.
 *   - Each service.destroy() and orchestrator.destroy() flushes any
 *     in-memory cache and releases its `static instance` field so the
 *     next getInstance() returns a fresh object that re-reads
 *     PerAccountLocalStorage. NEVER calls the existing clear() methods —
 *     those are destructive persistent-data wipes, not in-memory teardown.
 */

import type { AddonContext, AddonRuntime } from '../AddonLoader';
import { NospressService } from '../../services/NospressService';
import { NospressMenuService } from '../../services/NospressMenuService';
import { NospressPageIndexService } from '../../services/NospressPageIndexService';
import { NospressSiteSettingsService } from '../../services/NospressSiteSettingsService';
import { NospressMountsService } from '../../services/NospressMountsService';
import { NospressOrchestrator } from '../../services/orchestration/NospressOrchestrator';
import { NospressMenuOrchestrator } from '../../services/orchestration/NospressMenuOrchestrator';
import { NospressPageIndexOrchestrator } from '../../services/orchestration/NospressPageIndexOrchestrator';
import { NospressSiteSettingsOrchestrator } from '../../services/orchestration/NospressSiteSettingsOrchestrator';
import { NospressMountsOrchestrator } from '../../services/orchestration/NospressMountsOrchestrator';
import { removeUserCss } from './cssScope';

export class NospressRuntime implements AddonRuntime {
  private initialized = false;

  /**
   * Live orchestrator handles. Core consumers should access these via
   * `AddonLoader.getInstance().getRuntime<NospressRuntime>('nospress')?.<field>?.method(...)`
   * — a fresh fetch at every call site so a toggle-OFF (which nulls these
   * fields) is picked up transparently.
   *
   * The matching service singletons are kept private to the addon — every
   * consumer goes through an orchestrator anyway, and the services have
   * no behavior that core code needs direct access to.
   */
  public nospress: NospressOrchestrator | null = null;
  public mounts: NospressMountsOrchestrator | null = null;
  public menu: NospressMenuOrchestrator | null = null;
  public pageIndex: NospressPageIndexOrchestrator | null = null;
  public siteSettings: NospressSiteSettingsOrchestrator | null = null;

  async init(_ctx: AddonContext): Promise<void> {
    if (this.initialized) return;

    // Warm the service singletons first — orchestrator constructors call
    // their getInstance() so this just ensures they exist before the
    // orchestrators capture references.
    NospressService.getInstance();
    NospressMenuService.getInstance();
    NospressPageIndexService.getInstance();
    NospressSiteSettingsService.getInstance();
    NospressMountsService.getInstance();

    this.nospress = NospressOrchestrator.getInstance();
    this.mounts = NospressMountsOrchestrator.getInstance();
    this.menu = NospressMenuOrchestrator.getInstance();
    this.pageIndex = NospressPageIndexOrchestrator.getInstance();
    this.siteSettings = NospressSiteSettingsOrchestrator.getInstance();

    this.initialized = true;
  }

  async destroy(): Promise<void> {
    if (!this.initialized) return;

    removeUserCss();

    this.nospress?.destroy();
    this.mounts?.destroy();
    this.menu?.destroy();
    this.pageIndex?.destroy();
    this.siteSettings?.destroy();
    this.nospress = null;
    this.mounts = null;
    this.menu = null;
    this.pageIndex = null;
    this.siteSettings = null;

    NospressService.getInstance().destroy();
    NospressMenuService.getInstance().destroy();
    NospressPageIndexService.getInstance().destroy();
    NospressSiteSettingsService.getInstance().destroy();
    NospressMountsService.getInstance().destroy();

    this.initialized = false;
  }
}

export default new NospressRuntime();
