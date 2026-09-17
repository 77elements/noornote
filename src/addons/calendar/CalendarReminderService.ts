/**
 * CalendarReminderService - local reminder scheduler (addon-owned).
 *
 * Polls the calendar cache for events starting within the lead window and
 * raises an AlertBar once per occurrence (plus an OS notification when the
 * permission was granted). Local only: fires while the app is open, no
 * server, no push. Recurring events are expanded via NIP-52R occurrences.
 *
 * Pattern: NoteTakingReminderService (AlertBar) + NostrMajlisReminderService
 * (Web Notification API on Electron/Android, silent on web without consent).
 *
 * @service CalendarReminderService
 * @used-by CalendarRuntime
 */

import { AlertBarService } from '../../services/AlertBarService';
import { diagLog } from '../../services/DiagnosticLogger';
import { CalendarDataService } from './CalendarDataService';
import { getOccurrencesInRange } from '../../helpers/nip52/recurrence';
import type { CalendarEventData } from '../../helpers/nip52/parser';

const POLL_INTERVAL_MS = 30 * 1000;
/** Remind this many minutes before the start (default per open question — 10 min). */
const LEAD_TIME_MS = 10 * 60 * 1000;

export class CalendarReminderService {
  private static instance: CalendarReminderService | null = null;

  public static getInstance(): CalendarReminderService {
    if (!CalendarReminderService.instance) {
      CalendarReminderService.instance = new CalendarReminderService();
    }
    return CalendarReminderService.instance;
  }

  public static resetInstance(): void {
    CalendarReminderService.instance = null;
  }

  private timer: number | null = null;
  /** Already-fired reminder keys (coord@occurrenceStart) — session-scoped. */
  private readonly fired = new Set<string>();
  private destroyed = false;

  public start(): void {
    if (this.timer !== null || this.destroyed) return;
    void this.scan();
    this.timer = window.setInterval(() => void this.scan(), POLL_INTERVAL_MS);
  }

  public destroy(): void {
    this.destroyed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.fired.clear();
    CalendarReminderService.resetInstance();
  }

  private async scan(): Promise<void> {
    if (this.destroyed) return;
    const now = Date.now();
    const until = now + LEAD_TIME_MS;
    const events = CalendarDataService.getInstance().getCachedEvents();

    for (const event of events) {
      for (const occurrenceStart of getOccurrencesInRange(event, now, until)) {
        const key = `${event.coordinate}@${occurrenceStart}`;
        if (this.fired.has(key)) continue;
        this.fired.add(key);
        this.fire(event, occurrenceStart);
      }
    }
  }

  private fire(event: CalendarEventData, occurrenceStart: number): void {
    const title = event.title || 'Calendar event';
    const minutes = Math.max(
      0,
      Math.round((occurrenceStart - Date.now()) / 60000)
    );
    const when = minutes > 0 ? `in ${minutes} min` : 'now';
    diagLog('system', 'calendar: reminder fired', {
      dTag: event.dTag,
      inMinutes: minutes,
    });

    AlertBarService.getInstance().show({
      text: `${title} starts ${when}`,
      onOk: () => {},
    });

    // OS notification where the user granted permission (Electron/Android).
    if (
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted'
    ) {
      try {
        new Notification('NoorNote — Calendar', {
          body: `${title} starts ${when}`,
        });
      } catch {
        // Some platforms throw on construction — the AlertBar already fired.
      }
    }
  }
}
