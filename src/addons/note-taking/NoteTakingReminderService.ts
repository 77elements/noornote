/**
 * NoteTakingReminderService - note reminders via the central ReminderHub.
 *
 *  - Capacitor / Android: notes with a due-soon reminder are natively
 *    SCHEDULED as OS-level notifications (fire even when the app is closed).
 *  - Desktop / Web: 30s scan; due reminders raise the core AlertBar (Ok clears
 *    the reminder, Snooze reschedules it) plus an OS notification when the
 *    window is not focused.
 *
 * A click on the AlertBar text jumps to the board and pulses the note's card.
 * Owned by the addon runtime — destroy() clears the timer, cancels the native
 * namespace and resets the singleton (account-switch contract).
 *
 * @service NoteTakingReminderService
 * @used-by NoteTakingRuntime
 */

import { Router } from '../../services/Router';
import { AlertBarService } from '../../services/AlertBarService';
import { diagLog } from '../../services/DiagnosticLogger';
import {
  ReminderHub,
  type ReminderSpec,
} from '../../services/notifications/ReminderHub';
import { NoteTakingService } from './NoteTakingService';

const POLL_INTERVAL_MS = 30 * 1000;
const NAMESPACE = 'note-taking';
const ID_BASE = 90_003_000;
const POOL_SIZE = 32;
/** Android auto-dismisses the scheduled reminder 30 min after it fires. */
const TIMEOUT_AFTER_MS = 30 * 60 * 1000;

export class NoteTakingReminderService {
  private static instance: NoteTakingReminderService | null = null;
  private readonly service: NoteTakingService;
  private timer: number | null = null;
  /** Reminders currently raised (avoid re-firing the same one each poll). */
  private readonly shown = new Set<string>();
  private destroyed = false;

  private constructor() {
    this.service = NoteTakingService.getInstance();
  }

  public static getInstance(): NoteTakingReminderService {
    if (!NoteTakingReminderService.instance) {
      NoteTakingReminderService.instance = new NoteTakingReminderService();
    }
    return NoteTakingReminderService.instance;
  }

  public static resetInstance(): void {
    NoteTakingReminderService.instance = null;
  }

  /** Scan now (catches past-due reminders) and poll while the app is open. */
  public start(): void {
    if (this.timer !== null || this.destroyed) return;
    const hub = ReminderHub.getInstance();
    hub.registerNamespace({
      name: NAMESPACE,
      idBase: ID_BASE,
      poolSize: POOL_SIZE,
      build: () => this.buildUpcomingSpecs(),
    });

    void this.scan();
    this.timer = window.setInterval(() => void this.scan(), POLL_INTERVAL_MS);
  }

  public destroy(): void {
    this.destroyed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.shown.clear();
    const hub = ReminderHub.getInstance();
    void hub.disposeNamespace(NAMESPACE);
    NoteTakingReminderService.instance =
      undefined as unknown as NoteTakingReminderService;
  }

  /**
   * Upcoming scheduled notes for the native path: reminderAt within the next
   * 24 h (the scan path is the source of truth for already-fired ones).
   */
  private async buildUpcomingSpecs(): Promise<ReminderSpec[]> {
    if (this.destroyed) return [];
    const notes = await this.service.listNotes();
    const now = Date.now();
    const specs: ReminderSpec[] = [];
    for (const note of notes) {
      if (note.reminderAt <= 0) continue;
      const fireAt = note.reminderAt * 1000;
      if (fireAt <= now || fireAt > now + 24 * 60 * 60 * 1000) continue;
      if (specs.length >= POOL_SIZE) break;
      specs.push({
        id: ID_BASE + specs.length,
        title: 'Note reminder',
        body: note.title || note.body.slice(0, 80) || 'Note',
        fireAt,
        timeoutAfterMs: TIMEOUT_AFTER_MS,
        allowWhileIdle: true,
      });
    }
    return specs;
  }

  private async scan(): Promise<void> {
    if (this.destroyed) return;
    const hub = ReminderHub.getInstance();
    const now = Math.floor(Date.now() / 1000);
    let notes;
    try {
      notes = await this.service.listNotes();
    } catch {
      return;
    }
    for (const note of notes) {
      if (
        note.reminderAt > 0 &&
        note.reminderAt <= now &&
        !this.shown.has(note.id)
      ) {
        this.shown.add(note.id);
        this.fire(hub, note.id, note.title || note.body || 'Note');
      }
    }
  }

  private fire(hub: ReminderHub, id: string, label: string): void {
    const preview = label.length > 80 ? `${label.slice(0, 80)}…` : label;
    diagLog('system', 'note-taking: reminder fired', { id: id.slice(0, 8) });

    // Capacitor: the OS notification REPLACES the in-app AlertBar (NostrMajlis
    // pattern — no double-up). Desktop/Web: AlertBar + OS when unfocused.
    void hub.osNotifyNow({
      title: 'NoorNote — Note reminder',
      body: preview,
      timeoutAfterMs: TIMEOUT_AFTER_MS,
      osWhen: hub.isCapacitor ? 'always' : 'unfocused',
    });
    if (hub.isCapacitor) {
      // The user will clear/snooze via the OS shade; keep the native pool in
      // sync after any follow-up note change.
      hub.rescheduleSoon(NAMESPACE);
      return;
    }

    AlertBarService.getInstance().show({
      text: `Reminder: ${preview}`,
      onTextClick: () => {
        this.service.setHighlight(id);
        Router.getInstance().navigate('/addons/note-taking');
      },
      onOk: () => {
        this.shown.delete(id);
        void this.service.updateNote(id, { reminderAt: 0 });
      },
      onSnooze: minutes => {
        this.shown.delete(id);
        const next = Math.floor(Date.now() / 1000) + minutes * 60;
        void this.service.updateNote(id, { reminderAt: next });
      },
    });
  }
}
