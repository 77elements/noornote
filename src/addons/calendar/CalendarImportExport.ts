/**
 * CalendarImportExportManager — owner-side .ics import/export for the
 * Personal calendar tab.
 *
 * Import (serverless): the user picks a local .ics file, the file is parsed
 * in RAM (parseICSCalendar), filtered by an optional time range and shown as
 * a preview. "Publish imports" pushes the in-range candidates as own
 * kind-31923/31922 events — nothing touches relays before that click.
 *
 * Export: all own cached calendar events as one .ics download
 * (calendarEventsToICS).
 *
 * Mounted into the Calendar addon view (`data-addon-content="calendar-io"`).
 */

import { ToastService } from '../../services/ToastService';
import { AuthService } from '../../services/AuthService';
import { escapeHtml } from '../../helpers/escapeHtml';
import { calendarEventsToICS } from '../../helpers/nip52/icsExport';
import {
  parseICSCalendar,
  filterCandidatesByRange,
  candidateToDraftFields,
  type ICSImportCandidate,
} from '../../helpers/nip52/icsImport';
import {
  CalendarPublishService,
  buildEventModel,
} from './CalendarPublishService';
import { CalendarDataService } from './CalendarDataService';
import { TypedEventBus } from '../../core/TypedEventBus';
import { diagLog } from '../../services/DiagnosticLogger';

export class CalendarImportExportManager {
  private element: HTMLElement;
  private imported: ICSImportCandidate[] = [];
  private inRange: ICSImportCandidate[] = [];
  private loading = false;
  private publishing = false;
  private destroyed = false;
  /** Own items still on relays after a local wipe (null = no wipe pending). */
  private pendingResetCount: number | null = null;
  private wiping = false;

  constructor(slot: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'calendar-io';
    slot.appendChild(this.element);
    this.render();
  }

  private render(): void {
    const hasFile = this.imported.length > 0 || this.loading;
    const rangeDefaults = this.defaultRange();
    const draftsCount = CalendarDataService.getInstance().getDrafts().length;

    this.element.innerHTML = `
      <div class="calendar-io__import">
        <h3>Import</h3>
        <p class="form__note">
          Import a Google Calendar or any .ics export — events are previewed
          first and imported to this device. Publishing them to your relays is
          a separate step afterwards.
        </p>
        <div class="l-row--center calendar-io__actions">
          <button class="btn btn--large btn--passive" data-io-import>
            <svg width="20" height="20"><use href="#icon-upload"/></svg> Import .ics file
          </button>
          <input type="file" accept=".ics,text/calendar" data-io-file style="display: none" />
        </div>
        <div data-io-status></div>
        ${
          hasFile
            ? `<div class="calendar-io__range form__row form__row--oneline">
                <label class="calendar-io__range-label" for="io-range-from">Range</label>
                <input class="input datepicker" type="date" id="io-range-from" data-io-range-from value="${rangeDefaults.from}" />
                <span>–</span>
                <input class="input datepicker" type="date" data-io-range-to value="${rangeDefaults.to}" />
              </div>
              <div data-io-preview></div>
              <div class="l-row--right">
                <button class="btn" data-io-import-local disabled>Import to my calendar</button>
              </div>`
            : ''
        }
      </div>
      ${
        draftsCount > 0
          ? `<div class="calendar-io__pending">
              <h3>Publish imports</h3>
              <p class="form__note">
                ${draftsCount} imported ${draftsCount === 1 ? 'event is' : 'events are'}
                on this device only — they appear in your calendar locally, but
                your relays don't have them yet.
              </p>
              <div class="l-row--center calendar-io__actions">
                <button class="btn btn--large btn--passive" data-io-publish-drafts ${
                  this.publishing ? 'disabled' : ''
                }>
                  <svg width="20" height="20"><use href="#icon-upload"/></svg>
                  ${this.publishing ? 'Publishing…' : `Publish ${draftsCount} ${draftsCount === 1 ? 'event' : 'events'}`}
                </button>
                <button class="btn btn--passive" data-io-discard-drafts ${
                  this.publishing ? 'disabled' : ''
                }>Discard</button>
              </div>
            </div>`
          : ''
      }
      <h3>Export</h3>
      <p class="form__note">Download your whole calendar as one .ics file.</p>
      <div class="l-row--center calendar-io__actions">
        <button class="btn btn--large btn--passive" data-io-export>
          <svg width="20" height="20"><use href="#icon-download"/></svg> Export calendar (.ics)
        </button>
      </div>
      ${
        this.pendingResetCount !== null
          ? `<div class="calendar-io__reset">
              <h3>Reset</h3>
              <p class="form__note">
                Your calendar was cleared on this device. ${this.pendingResetCount}
                ${this.pendingResetCount === 1 ? 'item still' : 'items still'} on
                your relays — publishing the deletions makes the wipe permanent.
                Until then, reloading this page brings everything back.
              </p>
              <div class="l-row--center calendar-io__actions">
                <button class="btn btn--danger" data-io-publish-reset ${
                  this.wiping ? 'disabled' : ''
                }>
                  <svg width="20" height="20"><use href="#icon-trash"/></svg>
                  ${this.wiping ? 'Publishing…' : 'Publish deletions'}
                </button>
              </div>
            </div>`
          : `<h3>Reset</h3>
            <p class="form__note">
              Clears your calendar on this device only — events, booking slots,
              saved and private events. Like unsaved changes in a desktop app:
              your relays still have everything until you publish the wipe.
            </p>
            <div class="l-row--center calendar-io__actions">
              <button class="btn btn--danger" data-io-reset>
                <svg width="20" height="20"><use href="#icon-trash"/></svg> Reset calendar
              </button>
            </div>`
      }
    `;

    this.wire();
    if (hasFile) {
      this.renderPreview(this.inRange, 0);
      this.updatePublishButton(this.inRange.length);
    }
  }

  private defaultRange(): { from: string; to: string } {
    const day = (offsetDays: number): string =>
      new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
    return { from: day(0), to: day(120) };
  }

  private setStatus(text: string, pulsate = false): void {
    const status = this.element.querySelector('[data-io-status]');
    if (!status) return;
    status.innerHTML = text
      ? `<span class="${pulsate ? 'pulsate' : ''}">${escapeHtml(text)}</span>`
      : '';
  }

  private wire(): void {
    const importBtn = this.element.querySelector('[data-io-import]');
    const fileInput = this.element.querySelector(
      '[data-io-file]'
    ) as HTMLInputElement | null;
    importBtn?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) void this.importFile(file);
      fileInput.value = '';
    });

    this.element
      .querySelector('[data-io-export]')
      ?.addEventListener('click', () => this.exportCalendar());

    this.element
      .querySelector('[data-io-range-from]')
      ?.addEventListener('change', () => this.applyRange());
    this.element
      .querySelector('[data-io-range-to]')
      ?.addEventListener('change', () => this.applyRange());

    this.element
      .querySelector('[data-io-import-local]')
      ?.addEventListener('click', () => this.importLocal());

    this.element
      .querySelector('[data-io-publish-drafts]')
      ?.addEventListener('click', () => void this.publishDrafts());

    this.element
      .querySelector('[data-io-discard-drafts]')
      ?.addEventListener('click', () => void this.discardDrafts());

    this.element
      .querySelector('[data-io-reset]')
      ?.addEventListener('click', () => void this.resetLocal());

    this.element
      .querySelector('[data-io-publish-reset]')
      ?.addEventListener('click', () => void this.publishReset());
  }

  /**
   * Reset (local only): warn modal → wipe cache, saved externals, private
   * list state and reminder records. The wipe gate keeps relay refetches
   * from quietly restoring the data until the user publishes the deletions.
   */
  private async resetLocal(): Promise<void> {
    const { ModalService } = await import('../../services/ModalService');
    const ok = await ModalService.getInstance().confirm({
      title: 'Reset calendar?',
      message:
        'This clears your whole calendar on this device: events, booking slots, saved and private events. Nothing is deleted on your relays yet — click "Publish deletions" afterwards to make the wipe permanent, or reload the page to bring everything back.',
      confirmText: 'Reset locally',
      confirmDestructive: true,
    });
    if (!ok || this.destroyed) return;

    const dataService = CalendarDataService.getInstance();
    const count =
      dataService.getCachedEvents().length +
      dataService.getCachedCollections().length;
    dataService.wipeLocal();
    const { PrivateCalendarService } = await import('./PrivateCalendarService');
    PrivateCalendarService.getInstance().clearLocal();

    this.pendingResetCount = count;
    ToastService.show('Calendar cleared on this device', 'success');
    this.render();
  }

  /** Publish the wipe: delete everything the relays still have. */
  private async publishReset(): Promise<void> {
    if (this.wiping) return;
    this.wiping = true;
    this.render();
    try {
      const deleted =
        await CalendarPublishService.getInstance().wipeCalendarFromRelays();
      if (this.destroyed) return;
      this.pendingResetCount = null;
      ToastService.show(`${deleted} items deleted from your relays`, 'success');
      TypedEventBus.getInstance().emit('calendar:saved-changed', {});
    } catch (err) {
      if (this.destroyed) return;
      ToastService.show(
        `Publishing the deletions failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        'error'
      );
    }
    this.wiping = false;
    this.render();
  }

  private async importFile(file: File): Promise<void> {
    this.loading = true;
    this.setStatus(`Reading ${file.name}…`, true);
    try {
      const text = await file.text();
      const fallbackTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const preview = parseICSCalendar(text, fallbackTimeZone || 'UTC');
      if (this.destroyed) return;
      this.imported = preview.candidates;
      this.applyRange();
      this.setStatus(
        `${preview.candidates.length} events parsed${
          preview.cancelled || preview.failed
            ? ` (${preview.cancelled} cancelled, ${preview.failed} unparsable skipped)`
            : ''
        }`,
        false
      );
    } catch (err) {
      this.imported = [];
      this.setStatus(
        `Could not read the file: ${err instanceof Error ? err.message : String(err)}`,
        false
      );
    }
    this.render();
  }

  /** Re-run the range filter from the date inputs and refresh the preview. */
  private applyRange(): void {
    const from = (
      this.element.querySelector('[data-io-range-from]') as HTMLInputElement
    )?.value;
    const to = (
      this.element.querySelector('[data-io-range-to]') as HTMLInputElement
    )?.value;
    const { inRange, outOfRange } = filterCandidatesByRange(
      this.imported,
      from ? Date.parse(`${from}T00:00:00`) : null,
      to ? Date.parse(`${to}T23:59:59`) : null
    );
    this.inRange = inRange;
    this.renderPreview(inRange, outOfRange);
    this.updatePublishButton(inRange.length);
  }

  private renderPreview(inRange: ICSImportCandidate[], outOfRange = 0): void {
    const preview = this.element.querySelector('[data-io-preview]');
    if (!preview) return;
    if (inRange.length === 0) {
      preview.innerHTML = `<p class="form__note">No events in the selected range${
        outOfRange ? ` (${outOfRange} outside)` : ''
      }.</p>`;
      return;
    }
    const shown = inRange.slice(0, 10);
    const more = inRange.length - shown.length;
    preview.innerHTML = `<div class="ui-list">${shown
      .map(
        c => `<div class="ui-list__item">
          <span>${escapeHtml(
            new Date(c.startMs).toLocaleDateString('en-US', {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
            })
          )}</span>
          <span>${escapeHtml(c.title || '(Untitled event)')}${
            c.recurrence.frequency ? ' ↻' : ''
          }</span>
        </div>`
      )
      .join('')}${
      more > 0 ? `<div class="ui-list__item">…and ${more} more</div>` : ''
    }</div>`;
  }

  private updatePublishButton(count: number): void {
    const btn = this.element.querySelector(
      '[data-io-import-local]'
    ) as HTMLButtonElement | null;
    if (btn) btn.disabled = count === 0;
  }

  /**
   * Stage 1 of the import: build event models from the in-range candidates
   * and store them as local drafts — they show up in the grid immediately,
   * nothing touches relays yet.
   */
  private importLocal(): void {
    if (this.inRange.length === 0) return;
    const pubkey = AuthService.getInstance().getCurrentUser()?.pubkey;
    if (!pubkey) {
      ToastService.show('Not logged in', 'error');
      return;
    }
    const models = this.inRange.map(candidate =>
      buildEventModel(
        {
          ...candidateToDraftFields(candidate),
          dTag: candidate.dTag,
          image: '',
        },
        pubkey
      )
    );
    CalendarDataService.getInstance().addDrafts(models);
    this.imported = [];
    this.inRange = [];
    ToastService.show(
      `${models.length} events imported to this device`,
      'success'
    );
    TypedEventBus.getInstance().emit('calendar:saved-changed', {});
    this.render();
  }

  /**
   * Stage 2: publish the locally staged drafts to the relays. Failed events
   * stay staged for a retry.
   */
  private async publishDrafts(): Promise<void> {
    if (this.publishing) return;
    this.publishing = true;
    this.render();
    const publishService = CalendarPublishService.getInstance();
    const dataService = CalendarDataService.getInstance();
    const drafts = dataService.getDrafts();

    const publishedCoords: string[] = [];
    let failed = 0;
    for (const [index, model] of drafts.entries()) {
      this.setPendingStatus(`Publishing ${index + 1}/${drafts.length}…`);
      try {
        await publishService.publishEventModel(model);
        publishedCoords.push(model.coordinate);
      } catch (err) {
        failed++;
        diagLog('system', 'calendar: draft publish failed', {
          title: model.title,
          error: String(err),
        });
      }
    }

    this.publishing = false;
    dataService.removeDrafts(publishedCoords);
    this.render();
    if (failed > 0) {
      ToastService.show(
        `Publishing finished: ${publishedCoords.length} published, ${failed} failed (still staged)`,
        'warning'
      );
    } else {
      ToastService.show(
        `${publishedCoords.length} events published to your relays`,
        'success'
      );
    }
    TypedEventBus.getInstance().emit('calendar:saved-changed', {});
  }

  /** Progress text for the pending-drafts block (may be unmounted). */
  private setPendingStatus(text: string): void {
    const pending = this.element.querySelector('.calendar-io__pending');
    if (!pending) return;
    const note = pending.querySelector('.form__note');
    if (note) note.textContent = text;
  }

  /** Throw away all staged drafts without touching relays. */
  private async discardDrafts(): Promise<void> {
    const dataService = CalendarDataService.getInstance();
    const drafts = dataService.getDrafts();
    if (drafts.length === 0) return;
    const { ModalService } = await import('../../services/ModalService');
    const ok = await ModalService.getInstance().confirm({
      title: 'Discard imported events?',
      message: `This removes the ${drafts.length} locally imported ${
        drafts.length === 1 ? 'event' : 'events'
      } from this device. They were never published, so nothing is lost on your relays.`,
      confirmText: 'Discard',
      confirmDestructive: true,
    });
    if (!ok || this.destroyed) return;
    dataService.removeDrafts(drafts.map(draft => draft.coordinate));
    ToastService.show('Imported events discarded', 'success');
    TypedEventBus.getInstance().emit('calendar:saved-changed', {});
    this.render();
  }

  private exportCalendar(): void {
    const events = CalendarDataService.getInstance().getCachedEvents();
    if (events.length === 0) {
      ToastService.show('No events to export', 'info');
      return;
    }
    const ics = calendarEventsToICS(events);
    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'noornote-calendar.ics';
    link.click();
    URL.revokeObjectURL(url);
    ToastService.show(`Exported ${events.length} events`, 'success');
  }

  public destroy(): void {
    this.destroyed = true;
    this.element.remove();
  }
}
