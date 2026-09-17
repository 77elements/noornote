/**
 * Calendar runtime - AddonLoader lifecycle owner.
 *
 * Owns the local reminder scheduler and resets the data-service singleton on
 * destroy (account-switch contract: no cached events may leak across
 * accounts). The grid view itself is lazy-mounted via ViewMountingService.
 * Heavy modules are statically imported ONLY inside runtime.ts / the addon
 * view's dynamic import so rollup splits them into separate chunks.
 */

import type { AddonContext, AddonRuntime } from '../AddonLoader';
import { diagLog } from '../../services/DiagnosticLogger';
import { CalendarReminderService } from './CalendarReminderService';
import { CalendarDataService } from './CalendarDataService';
import { CalendarInviteService } from './CalendarInviteService';

export class CalendarRuntime implements AddonRuntime {
  private initialized = false;

  async init(ctx: AddonContext): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    CalendarReminderService.getInstance().start();
    diagLog('system', 'calendar: runtime init', {
      npub: ctx.npub?.slice(0, 12),
    });
  }

  async destroy(): Promise<void> {
    if (!this.initialized) return;
    this.initialized = false;
    CalendarReminderService.getInstance().destroy();
    CalendarDataService.getInstance().destroy();
    CalendarInviteService.getInstance().destroy();
    diagLog('system', 'calendar: runtime destroy');
  }
}

export default new CalendarRuntime();
