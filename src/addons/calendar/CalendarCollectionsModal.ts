/**
 * CalendarCollectionsModal - manage the user's own public event calendars
 * (kind 31924): list, create, edit (title + event membership) and delete.
 *
 * Opened from the calendar grid toolbar. Editing picks events from the
 * currently loaded grid — PRIVATE events (32678/32123) are never offered,
 * since referencing their coordinates in a public collection would leak
 * metadata.
 */

import { ModalService } from '../../services/ModalService';
import { ErrorService } from '../../services/ErrorService';
import { ToastService } from '../../services/ToastService';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { Tooltip } from '../../components/ui/Tooltip';
import { generateDTag } from './CalendarPublishService';
import { CalendarDataService } from './CalendarDataService';
import type {
  CalendarCollectionData,
  CalendarEventData,
} from '../../helpers/nip52/parser';

export class CalendarCollectionsModal {
  constructor(private readonly onChanged: () => void) {}

  public open(): void {
    const content = document.createElement('div');
    content.className = 'calendar-collections';
    this.renderList(content);

    ModalService.getInstance().show({
      title: 'Your event calendars',
      content,
      width: '520px',
    });
  }

  private renderList(content: HTMLElement): void {
    const collections =
      CalendarDataService.getInstance().getCachedCollections();
    content.innerHTML = `
      <div class="l-row--right calendar-collections__new">
        <button class="btn btn--mini" type="button" data-action="new">+ New event calendar</button>
      </div>
      <div class="ui-list" data-slot="list"></div>
    `;

    const list = content.querySelector('[data-slot="list"]')!;
    if (collections.length === 0) {
      list.innerHTML =
        '<div class="calendar-collections__empty">No event calendars yet. Create one and add your public events to it.</div>';
    }
    for (const collection of collections) {
      const row = document.createElement('div');
      row.className = 'ui-list__item calendar-collections__row';
      row.innerHTML = `
        <span class="calendar-collections__title">${escapeHtml(collection.title || 'Untitled calendar')}</span>
        <span class="calendar-collections__meta">${collection.eventRefs.length} events</span>
        <span class="l-row">
          <button class="btn btn--passive btn--mini" type="button" data-action="edit">Edit</button>
          <button class="btn btn--danger btn--mini" type="button" data-action="delete">Delete</button>
        </span>
      `;
      row
        .querySelector('[data-action="edit"]')
        ?.addEventListener('click', () => {
          ModalService.getInstance().hide();
          new CalendarCollectionEditorModal(collection, this.onChanged).open();
        });
      row
        .querySelector('[data-action="delete"]')
        ?.addEventListener('click', () => {
          void this.remove(collection);
        });
      list.appendChild(row);
    }

    content
      .querySelector('[data-action="new"]')
      ?.addEventListener('click', () => {
        ModalService.getInstance().hide();
        new CalendarCollectionEditorModal(null, this.onChanged).open();
      });
  }

  private async remove(collection: CalendarCollectionData): Promise<void> {
    const confirmed = await ModalService.getInstance().confirm({
      title: 'Delete event calendar',
      message: `Delete the calendar "${collection.title || 'Untitled calendar'}"? Subscribers keep their events, but it will no longer exist as a calendar.`,
      confirmText: 'Delete',
      confirmDestructive: true,
    });
    if (!confirmed) return;
    try {
      const { CalendarPublishService } = await import(
        './CalendarPublishService'
      );
      const ok =
        await CalendarPublishService.getInstance().deleteCollection(collection);
      if (!ok) {
        ToastService.show('Deletion was not acknowledged', 'warning');
        return;
      }
      ToastService.show('Event calendar deleted', 'success');
      ModalService.getInstance().hide();
      this.onChanged();
    } catch (error) {
      ErrorService.handle(
        error,
        'CalendarCollectionsModal.remove',
        true,
        'Could not delete the event calendar'
      );
    }
  }
}

export class CalendarCollectionEditorModal {
  private selected = new Set<string>();
  private tooltipDisposers: Array<() => void> = [];

  constructor(
    private readonly existing: CalendarCollectionData | null,
    private readonly onSaved: () => void
  ) {
    if (existing) {
      for (const ref of existing.eventRefs) this.selected.add(ref);
    }
  }

  public open(): void {
    const content = document.createElement('div');
    content.className = 'calendar-collection-editor';

    const selectable = this.selectableEvents();
    content.innerHTML = `
      <div class="form__row">
        <label for="cal-col-title">Calendar name</label>
        <input id="cal-col-title" class="input input--title" type="text" maxlength="120"
          placeholder="e.g. My meetups 2026" value="${escapeHtmlAttr(this.existing?.title ?? '')}" />
      </div>
      <div class="calendar-collection-editor__events">
        <span class="setting__label">Add public events</span>
        <p class="form__note">Pick from the events currently in your grid. Subscribers get all of them and any future changes.</p>
        <div class="ui-list calendar-collections__pick-list" data-slot="events">
          ${
            selectable.length === 0
              ? '<div class="calendar-collections__empty">No public events in your grid yet — create an event first.</div>'
              : ''
          }
        </div>
      </div>
      <div class="calendar-addon-editor__actions l-row--end-pair">
        <button class="btn btn--passive btn--medium" type="button" data-action="cancel">Cancel</button>
        <button class="btn btn--medium" type="button" data-action="save">${this.existing ? 'Save changes' : 'Publish calendar'}</button>
      </div>
    `;

    const list = content.querySelector('[data-slot="events"]')!;
    for (const event of selectable) {
      const checked = this.selected.has(event.coordinate);
      const row = document.createElement('label');
      row.className =
        'nn-checkbox nn-checkbox--label-left calendar-collections__pick';
      row.innerHTML = `
        <span class="calendar-collections__pick-label">
          <span class="calendar-collections__title">${escapeHtml(event.title || '(Untitled event)')}</span>
          <span class="calendar-collections__meta">${escapeHtml(this.dateLabel(event))}</span>
        </span>
        <input type="checkbox" data-coordinate="${escapeHtmlAttr(event.coordinate)}" ${checked ? 'checked' : ''} />
      `;
      row.querySelector('input')?.addEventListener('change', e => {
        const box = e.target as HTMLInputElement;
        if (box.checked) this.selected.add(event.coordinate);
        else this.selected.delete(event.coordinate);
      });
      list.appendChild(row);
      // Whole row is the click target — explain the interaction on hover.
      this.tooltipDisposers.push(Tooltip.attach(row, 'Click/tap to select'));
    }

    content
      .querySelector('[data-action="cancel"]')
      ?.addEventListener('click', () => ModalService.getInstance().hide());
    content
      .querySelector('[data-action="save"]')
      ?.addEventListener('click', () => void this.save(content));

    ModalService.getInstance().show({
      title: this.existing ? 'Edit event calendar' : 'New event calendar',
      content,
      width: '520px',
      onClose: () => this.dispose(),
    });
  }

  /** Tooltip disposers (destroy contract — modal teardown). */
  private dispose(): void {
    for (const dispose of this.tooltipDisposers) dispose();
    this.tooltipDisposers = [];
  }

  /** Public calendar events available for membership (own + subscribed). */
  private selectableEvents(): CalendarEventData[] {
    return CalendarDataService.getInstance()
      .getCachedEvents()
      .filter(ev => !ev.isPrivate)
      .sort((a, b) => a.startMs - b.startMs);
  }

  private dateLabel(event: CalendarEventData): string {
    return new Date(event.startMs).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }

  private async save(content: HTMLElement): Promise<void> {
    const title =
      content.querySelector<HTMLInputElement>('#cal-col-title')!.value;
    if (!title.trim()) {
      ToastService.show('Please enter a calendar name', 'warning');
      return;
    }
    try {
      const { CalendarPublishService } = await import(
        './CalendarPublishService'
      );
      await CalendarPublishService.getInstance().publishCollection({
        dTag: this.existing?.dTag ?? generateDTag(),
        title,
        description: this.existing?.description ?? '',
        eventRefs: [...this.selected],
      });
      ToastService.show(
        this.existing ? 'Event calendar updated' : 'Event calendar published',
        'success'
      );
      ModalService.getInstance().hide();
      this.onSaved();
    } catch (error) {
      ErrorService.handle(
        error,
        'CalendarCollectionEditorModal.save',
        true,
        'Could not save the event calendar'
      );
    }
  }
}
