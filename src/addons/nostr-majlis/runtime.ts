/**
 * nostr-majlis addon runtime (AddonLoader lifecycle).
 *
 * Owns DiyanetService (official prayer times, runtime-fetched + cached), the prayer reminder
 * scheduler, and the sidebar countdown widget. All torn down by destroy() so timers / DOM /
 * state / OS alarms never leak across logout / account-switch / toggle-off.
 *
 * Reminder split by platform:
 *  - Capacitor (Android): native scheduled local notifications (fire when app closed / asleep).
 *  - Electron / Web: the in-app AlertBar poll (only meaningful while the app is open).
 * They are mutually exclusive so a reminder never fires twice on the same device.
 * See docs/todos/muslims-addon.md.
 */

import type { AddonContext, AddonRuntime } from '../AddonLoader';
import { PlatformService } from '../../services/PlatformService';
import { diagLog } from '../../services/DiagnosticLogger';
import { DiyanetService } from './DiyanetService';
import { NostrMajlisReminderService } from './NostrMajlisReminderService';
import { NostrMajlisNativeReminders } from './NostrMajlisNativeReminders';
import { NostrMajlisSidebarWidget } from './NostrMajlisSidebarWidget';

export class NostrMajlisRuntime implements AddonRuntime {
  private initialized = false;
  private native: NostrMajlisNativeReminders | null = null;
  /** Public so the settings view can refresh it live via AddonLoader.getRuntime(). */
  public widget: NostrMajlisSidebarWidget | null = null;

  async init(ctx: AddonContext): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    DiyanetService.getInstance();

    if (PlatformService.getInstance().isCapacitor) {
      this.native = new NostrMajlisNativeReminders();
      void this.native.start();
    } else {
      NostrMajlisReminderService.getInstance().start();
    }

    this.widget = new NostrMajlisSidebarWidget();
    this.widget.mount();
    diagLog('addons', 'nostr-majlis: runtime init', { npub: ctx.npub?.slice(0, 12) });
  }

  async destroy(): Promise<void> {
    if (!this.initialized) return;
    this.initialized = false;
    this.widget?.destroy();
    this.widget = null;
    if (this.native) { await this.native.destroy(); this.native = null; }
    else NostrMajlisReminderService.getInstance().destroy();
    DiyanetService.getInstance().destroy();
    diagLog('addons', 'nostr-majlis: runtime destroy');
  }
}

export default new NostrMajlisRuntime();
