/**
 * NoteDraftService - Persistent per-account composer drafts.
 *
 * Two kinds of entries live in ONE list (Jumble model):
 *  - manual drafts (failed === false): saved via the composer's "Save draft" button
 *  - failed posts  (failed === true):  auto-saved when signing/publishing fails
 *
 * Both surface in the composer's "Drafts" tab; failed entries are marked.
 * Storage is per-account via PerAccountLocalStorage, so drafts never leak
 * across account switches.
 */

import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';

export type NoteDraftType = 'note' | 'reply' | 'quote' | 'highlight';

export interface NoteDraft {
  id: string;
  type: NoteDraftType;
  /** Raw composer text (quote/highlight refs are embedded inline). */
  content: string;
  /** Epoch milliseconds. */
  createdAt: number;
  /** True = a post that could not be signed/published; false = a manual save. */
  failed: boolean;
  /** Human-readable reason for a failed entry (e.g. "Signer did not respond in time"). */
  failureReason?: string;
  /** Reply target event id — used to reopen the reply composer with its parent. */
  parentEventId?: string;
  /** Display-only context line, e.g. "Reply to @alice". */
  contextLabel?: string;
}

export type NoteDraftInput = Omit<NoteDraft, 'id' | 'createdAt'>;

/** Hard cap so a runaway never bloats localStorage; oldest entries drop first. */
const MAX_DRAFTS = 50;

export class NoteDraftService {
  private static instance: NoteDraftService;
  private store: PerAccountLocalStorage;

  private constructor() {
    this.store = PerAccountLocalStorage.getInstance();
  }

  public static getInstance(): NoteDraftService {
    if (!NoteDraftService.instance) {
      NoteDraftService.instance = new NoteDraftService();
    }
    return NoteDraftService.instance;
  }

  /** All drafts for the current account, newest first. */
  public list(): NoteDraft[] {
    const all = this.store.get<NoteDraft[]>(StorageKeys.NOTE_DRAFTS, []);
    return [...all].sort((a, b) => b.createdAt - a.createdAt);
  }

  public count(): number {
    return this.store.get<NoteDraft[]>(StorageKeys.NOTE_DRAFTS, []).length;
  }

  /** Add a new draft (manual or failed). Returns the stored draft. */
  public add(input: NoteDraftInput): NoteDraft {
    const draft: NoteDraft = {
      ...input,
      id: this.newId(),
      createdAt: Date.now(),
    };
    const all = this.store.get<NoteDraft[]>(StorageKeys.NOTE_DRAFTS, []);
    all.push(draft);
    const trimmed = all
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_DRAFTS);
    this.store.set(StorageKeys.NOTE_DRAFTS, trimmed);
    return draft;
  }

  public remove(id: string): void {
    const all = this.store.get<NoteDraft[]>(StorageKeys.NOTE_DRAFTS, []);
    this.store.set(
      StorageKeys.NOTE_DRAFTS,
      all.filter(d => d.id !== id)
    );
  }

  private newId(): string {
    try {
      return crypto.randomUUID();
    } catch {
      return `draft-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    }
  }
}
