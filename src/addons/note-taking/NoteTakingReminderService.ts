/**
 * NoteTakingReminderService - local reminder scheduler (addon-owned).
 *
 * Polls the note store for due reminders (reminderAt > 0 && <= now) and raises
 * them through the generic core AlertBarService. Local only: fires while the app
 * is open, and catches past-due reminders on the next start. No server, no push.
 *
 * Ok clears the reminder; Snooze reschedules it. A click on the bar text jumps
 * to the board and pulses the note's card.
 *
 * @service NoteTakingReminderService
 * @used-by NoteTakingRuntime
 */

import { Router } from '../../services/Router';
import { AlertBarService } from '../../services/AlertBarService';
import { diagLog } from '../../services/DiagnosticLogger';
import { NoteTakingService } from './NoteTakingService';

const POLL_INTERVAL_MS = 30 * 1000;

export class NoteTakingReminderService {
  private static instance: NoteTakingReminderService;
  private readonly service: NoteTakingService;
  private timer: number | null = null;
  /** Reminders currently raised (avoid re-firing the same one each poll). */
  private readonly shown = new Set<string>();

  private constructor() {
    this.service = NoteTakingService.getInstance();
  }

  public static getInstance(): NoteTakingReminderService {
    if (!NoteTakingReminderService.instance) {
      NoteTakingReminderService.instance = new NoteTakingReminderService();
    }
    return NoteTakingReminderService.instance;
  }

  /** Scan now (catches past-due reminders) and poll while the app is open. */
  public start(): void {
    void this.scan();
    this.timer = window.setInterval(() => void this.scan(), POLL_INTERVAL_MS);
  }

  public destroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.shown.clear();
    NoteTakingReminderService.instance = undefined as unknown as NoteTakingReminderService;
  }

  private async scan(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    let notes;
    try {
      notes = await this.service.listNotes();
    } catch {
      return;
    }
    for (const note of notes) {
      if (note.reminderAt > 0 && note.reminderAt <= now && !this.shown.has(note.id)) {
        this.shown.add(note.id);
        this.fire(note.id, note.title || note.body || 'Note');
      }
    }
  }

  private fire(id: string, label: string): void {
    const preview = label.length > 80 ? `${label.slice(0, 80)}…` : label;
    diagLog('system', 'note-taking: reminder fired', { id: id.slice(0, 8) });
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
      onSnooze: (minutes) => {
        this.shown.delete(id);
        const next = Math.floor(Date.now() / 1000) + minutes * 60;
        void this.service.updateNote(id, { reminderAt: next });
      },
    });
  }
}
