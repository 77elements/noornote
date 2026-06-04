/**
 * nostr-majlis addon runtime (AddonLoader lifecycle).
 *
 * Owns DiyanetService (official prayer times, runtime-fetched + cached), the in-app
 * reminder scheduler (AlertBar), and the sidebar countdown widget. All torn down by
 * destroy() so timers/DOM/state never leak across logout / account-switch / toggle-off.
 * Native sleep-screen notifications are S4. See docs/todos/muslims-addon.md.
 */

import type { AddonContext, AddonRuntime } from '../AddonLoader';
import { diagLog } from '../../services/DiagnosticLogger';
import { DiyanetService } from './DiyanetService';
import { NostrMajlisReminderService } from './NostrMajlisReminderService';
import { NostrMajlisSidebarWidget } from './NostrMajlisSidebarWidget';

export class NostrMajlisRuntime implements AddonRuntime {
  private initialized = false;
  /** Public so the settings view can refresh it live via AddonLoader.getRuntime(). */
  public widget: NostrMajlisSidebarWidget | null = null;

  async init(ctx: AddonContext): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    DiyanetService.getInstance();
    NostrMajlisReminderService.getInstance().start();
    this.widget = new NostrMajlisSidebarWidget();
    this.widget.mount();
    diagLog('addons', 'nostr-majlis: runtime init', { npub: ctx.npub?.slice(0, 12) });
  }

  async destroy(): Promise<void> {
    if (!this.initialized) return;
    this.initialized = false;
    this.widget?.destroy();
    this.widget = null;
    NostrMajlisReminderService.getInstance().destroy();
    DiyanetService.getInstance().destroy();
    diagLog('addons', 'nostr-majlis: runtime destroy');
  }
}

export default new NostrMajlisRuntime();
