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
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../services/PerAccountLocalStorage';
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
/** Default lead time in minutes (10) when no addon/event override is set. */
const DEFAULT_LEAD_MIN = 10;
/** Lead value meaning "never remind" (stored as 0). */
export const LEAD_NEVER = 0;
/** Largest supported lead: 1 week in minutes (scheduling window bound). */
const MAX_LEAD_MIN = 10_080;
/** Android auto-dismisses the scheduled reminder 30 min after the start. */
const TIMEOUT_AFTER_MS = 30 * 60 * 1000;
const NAMESPACE = 'calendar';
const ID_BASE = 90_002_000;
const POOL_SIZE = 64;

/** Lead options shared by the addon settings + event editor dropdowns. */
export interface LeadOption {
  value: string;
  label: string;
}

/** Single source of truth for reminder lead choices (minutes). */
export const LEAD_OPTIONS: LeadOption[] = [
  { value: '10', label: '10 min before' },
  { value: '30', label: '30 min before' },
  { value: '60', label: '1 hour before' },
  { value: '120', label: '2 hours before' },
  { value: '1440', label: '1 day before' },
  { value: '4320', label: '3 days before' },
  { value: '10080', label: '1 week before' },
  { value: '0', label: 'Never' },
];

/** Humanize a lead in minutes: "in 10 min" / "in 2 h" / "in 1 day" / "in 1 week". */
export function humanizeLeadMinutes(minutes: number): string {
  if (minutes < 60) return `in ${minutes} min`;
  if (minutes < 1440) {
    const hours = Math.round(minutes / 60);
    return `in ${hours} h`;
  }
  if (minutes < 10_080) {
    const days = Math.round(minutes / 1440);
    return `in ${days} day${days === 1 ? '' : 's'}`;
  }
  const weeks = Math.round(minutes / 10_080);
  return `in ${weeks} week${weeks === 1 ? '' : 's'}`;
}

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

  // ---------- lead-time settings (phase: editable leads) ----------

  /** Addon-wide default lead in minutes (0 = never). */
  public getDefaultLeadMin(): number {
    return PerAccountLocalStorage.getInstance().get<number>(
      StorageKeys.CALENDAR_REMINDER_LEAD,
      DEFAULT_LEAD_MIN
    );
  }

  public setDefaultLeadMin(minutes: number): void {
    PerAccountLocalStorage.getInstance().set(
      StorageKeys.CALENDAR_REMINDER_LEAD,
      minutes
    );
    diagLog('system', 'calendar: default reminder lead set', { minutes });
    this.onLeadSettingsChanged();
  }

  /** Per-event override in minutes (0 = never); null removes the override. */
  public setEventLead(coordinate: string, minutes: number | null): void {
    const leads = PerAccountLocalStorage.getInstance().get<
      Record<string, number>
    >(StorageKeys.CALENDAR_EVENT_LEADS, {});
    if (minutes === null) delete leads[coordinate];
    else leads[coordinate] = minutes;
    PerAccountLocalStorage.getInstance().set(
      StorageKeys.CALENDAR_EVENT_LEADS,
      leads
    );
    diagLog('system', 'calendar: event reminder lead set', {
      coordinate: coordinate.slice(0, 40),
      minutes,
    });
    this.onLeadSettingsChanged();
  }

  /** Stored per-event override, or null when the event uses the default. */
  public getEventLeadOverride(coordinate: string): number | null {
    const leads = PerAccountLocalStorage.getInstance().get<
      Record<string, number>
    >(StorageKeys.CALENDAR_EVENT_LEADS, {});
    return coordinate in leads ? (leads[coordinate] ?? null) : null;
  }

  /** Resolved lead for an event in minutes, or null when reminders are off. */
  public getLeadFor(event: CalendarEventData): number | null {
    const override = this.getEventLeadOverride(event.coordinate);
    const minutes = override ?? this.getDefaultLeadMin();
    if (minutes <= 0) return null;
    return Math.min(minutes, MAX_LEAD_MIN);
  }

  /** Apply lead changes immediately: rebuild native specs + rescan. */
  public onLeadSettingsChanged(): void {
    if (this.destroyed) return;
    const hub = ReminderHub.getInstance();
    hub.rescheduleSoon(NAMESPACE);
    void this.scan();
  }

  // ---------- acknowledgement ("Ok" = never again) ----------

  private loadAcked(): Set<string> {
    if (this.acked) return this.acked;
    const raw = PerAccountLocalStorage.getInstance().get<string[]>(
      StorageKeys.CALENDAR_REMINDER_ACKED,
      []
    );
    // Prune: keys are `coordinate@occStartMs`; drop entries whose occurrence
    // is more than a day in the past (nothing can re-fire for them anyway).
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const fresh = raw.filter(key => {
      const occurrence = Number(key.split('@')[1]);
      return Number.isFinite(occurrence) && occurrence > dayAgo;
    });
    if (fresh.length !== raw.length) {
      PerAccountLocalStorage.getInstance().set(
        StorageKeys.CALENDAR_REMINDER_ACKED,
        fresh
      );
    }
    this.acked = new Set(fresh);
    return this.acked;
  }

  private acknowledge(key: string): void {
    const acked = this.loadAcked();
    acked.add(key);
    PerAccountLocalStorage.getInstance().set(
      StorageKeys.CALENDAR_REMINDER_ACKED,
      [...acked]
    );
  }

  private timer: number | null = null;
  private busSubId: string | null = null;
  /** Fired this session (fast path). */
  private readonly fired = new Set<string>();
  /**
   * Acknowledged with "Ok" — PERSISTENT (per account): a dismissed reminder
   * stays dismissed across reloads and restarts. Pruned lazily on load.
   */
  private acked: Set<string> | null = null;
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
   * the max scheduling window (1 week), reminder firing per-event lead before
   * the start. Events with reminders off (lead 0) are skipped.
   */
  private buildUpcomingSpecs(): ReminderSpec[] {
    if (this.destroyed) return [];
    const now = Date.now();
    const until = now + MAX_LEAD_MIN * 60_000;
    const events = CalendarDataService.getInstance().getCachedEvents();

    const specs: ReminderSpec[] = [];
    const seen = new Set<string>();
    for (const event of events) {
      const leadMin = this.getLeadFor(event);
      if (leadMin === null) continue;
      for (const occurrenceStart of getOccurrencesInRange(event, now, until)) {
        const fireAt = occurrenceStart - leadMin * 60_000;
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
    const events = CalendarDataService.getInstance().getCachedEvents();

    for (const event of events) {
      const leadMin = this.getLeadFor(event);
      if (leadMin === null) continue;
      const until = now + leadMin * 60_000;
      for (const occurrenceStart of getOccurrencesInRange(event, now, until)) {
        const key = `${event.coordinate}@${occurrenceStart}`;
        if (this.fired.has(key) || this.loadAcked().has(key)) continue;
        this.fired.add(key);
        this.fire(event, leadMin, key);
      }
    }
  }

  private fire(event: CalendarEventData, leadMin: number, key: string): void {
    const title = event.title || 'Calendar event';
    const when = humanizeLeadMinutes(leadMin);
    diagLog('system', 'calendar: reminder fired', {
      dTag: event.dTag,
      leadMinutes: leadMin,
    });

    AlertBarService.getInstance().show({
      text: `${title} starts ${when}`,
      // "Ok" acknowledges PERSISTENTLY — the reminder never comes back for
      // this occurrence (even after reload / app restart).
      onOk: () => this.acknowledge(key),
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
