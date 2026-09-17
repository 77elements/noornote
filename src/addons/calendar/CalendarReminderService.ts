/**
 * CalendarReminderService - platform-aware calendar reminders via the central
 * ReminderHub (NostrMajlis pattern).
 *
 *  - Capacitor / Android: upcoming events are natively SCHEDULED as OS-level
 *    notifications (they fire even when the app is closed) — namespace
 *    'calendar', occurrence-aware over NIP-52R recurrences, re-built on data
 *    refresh and app resume. The in-app AlertBar is skipped there (the OS
 *    notification also shows in the foreground — no double-up).
 *  - Desktop / Web: 30s scan over the cache; due reminders raise the core
 *    AlertBar plus an OS notification when the window is not focused.
 *
 * Local only: no server, no push. Owned by the addon runtime — destroy()
 * cancels the namespace (native pending notifications included).
 */

import { AlertBarService } from '../../services/AlertBarService';
import { diagLog } from '../../services/DiagnosticLogger';
import { TypedEventBus } from '../../core/TypedEventBus';
import {
  ReminderHub,
  type ReminderSpec,
} from '../../services/notifications/ReminderHub';
import { CalendarDataService } from './CalendarDataService';
import { getOccurrencesInRange } from '../../helpers/nip52/recurrence';
import type { CalendarEventData } from '../../helpers/nip52/parser';

const POLL_INTERVAL_MS = 30 * 1000;
/** Remind this many minutes before the start (default per open question — 10 min). */
const LEAD_TIME_MS = 10 * 60 * 1000;
/** Native scheduling window: rebuild specs for events starting within 7 days. */
const SCHEDULE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Android auto-dismisses the scheduled reminder 30 min after the start. */
const TIMEOUT_AFTER_MS = 30 * 60 * 1000;
const NAMESPACE = 'calendar';
const ID_BASE = 90_002_000;
const POOL_SIZE = 64;

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
  private busSubId: string | null = null;
  /** Already-fired reminder keys (coord@occurrenceStart) — session-scoped. */
  private readonly fired = new Set<string>();
  private destroyed = false;

  public start(): void {
    if (this.timer !== null || this.destroyed) return;
    const hub = ReminderHub.getInstance();

    hub.registerNamespace({
      name: NAMESPACE,
      idBase: ID_BASE,
      poolSize: POOL_SIZE,
      build: () => Promise.resolve(this.buildUpcomingSpecs()),
    });
    this.busSubId = TypedEventBus.getInstance().on(
      'calendar:data-refreshed',
      () => {
        hub.rescheduleSoon(NAMESPACE);
        void this.scan();
      }
    );

    if (hub.isCapacitor) {
      // Native path: pre-scheduled OS notifications, no in-app scan needed.
      hub.rescheduleSoon(NAMESPACE);
      diagLog('system', 'calendar: reminders on native schedule');
      return;
    }

    void this.scan();
    this.timer = window.setInterval(() => void this.scan(), POLL_INTERVAL_MS);
  }

  public destroy(): void {
    this.destroyed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.busSubId) {
      TypedEventBus.getInstance().off(this.busSubId);
      this.busSubId = null;
    }
    this.fired.clear();
    const hub = ReminderHub.getInstance();
    void hub.disposeNamespace(NAMESPACE);
    CalendarReminderService.resetInstance();
  }

  /**
   * Upcoming occurrences for the native schedule: every event starting within
   * the scheduling window, reminder firing LEAD_TIME before the start.
   */
  private buildUpcomingSpecs(): ReminderSpec[] {
    if (this.destroyed) return [];
    const now = Date.now();
    const until = now + SCHEDULE_WINDOW_MS;
    const events = CalendarDataService.getInstance().getCachedEvents();

    const specs: ReminderSpec[] = [];
    const seen = new Set<string>();
    for (const event of events) {
      for (const occurrenceStart of getOccurrencesInRange(event, now, until)) {
        const fireAt = occurrenceStart - LEAD_TIME_MS;
        const key = `${event.coordinate}@${occurrenceStart}`;
        if (seen.has(key) || fireAt <= now) continue;
        if (specs.length >= POOL_SIZE) return specs;
        seen.add(key);
        specs.push({
          id: ID_BASE + specs.length,
          title: event.title || 'Calendar event',
          body: this.nativeBody(occurrenceStart, event.allDay),
          fireAt,
          timeoutAfterMs: TIMEOUT_AFTER_MS,
          allowWhileIdle: true,
        });
      }
    }
    return specs;
  }

  private nativeBody(occurrenceStart: number, allDay: boolean): string {
    const date = new Date(occurrenceStart).toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
    if (allDay) return `${date}, all day`;
    const time = new Date(occurrenceStart).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
    return `${date}, ${time}`;
  }

  private async scan(): Promise<void> {
    if (this.destroyed || ReminderHub.getInstance().isCapacitor) return;
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

    // OS notification on top (desktop path — web Notification API; the hub
    // applies the unfocused rule). On Capacitor the scan never runs.
    void ReminderHub.getInstance().osNotifyNow({
      title: 'NoorNote — Calendar',
      body: `${title} starts ${when}`,
      timeoutAfterMs: TIMEOUT_AFTER_MS,
      osWhen: 'unfocused',
    });
  }
}
