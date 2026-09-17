/**
 * CalendarEventEditor - create/edit modal for NIP-52 calendar events.
 *
 * All-day toggles between kind 31923 (timed) and 31922 (date-based).
 * Recurrence uses the NIP-52R frequency set (RRULE is built from the start
 * time). Publishing goes through CalendarPublishService (AuthService sign +
 * NostrTransport outbox publish). Delete routes through DeletionService.
 */

import { ModalService } from '../../services/ModalService';
import { ErrorService } from '../../services/ErrorService';
import { ToastService } from '../../services/ToastService';
import { Switch } from '../../components/ui/Switch';
import {
  CustomDropdown,
  type DropdownOption,
} from '../../components/ui/CustomDropdown';
import { decodeNip19 } from '../../services/NostrToolsAdapter';
import { escapeHtmlAttr } from '../../helpers/escapeHtml';
import {
  buildRecurrenceRule,
  parseRecurrenceRule,
  type RecurrenceFrequency,
} from '../../helpers/nip52/recurrence';
import {
  generateDTag,
  type CalendarEventDraft,
} from './CalendarPublishService';
import type { CalendarEventData } from '../../helpers/nip52/parser';

const REPEAT_OPTIONS: DropdownOption[] = [
  { value: 'none', label: 'Does not repeat' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'weekdays', label: 'Every weekday (Mon–Fri)' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Every 3 months' },
  { value: 'yearly', label: 'Yearly' },
];

function toDatetimeLocal(ms: number): string {
  // Local-time rendering for <input type="datetime-local">.
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toLocalDateInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export class CalendarEventEditor {
  private allDaySwitch: Switch | null = null;
  private privateSwitch: Switch | null = null;
  private repeatDropdown: CustomDropdown | null = null;
  private repeatValue: RecurrenceFrequency | null;
  private isPrivate: boolean;
  /** Existing event being edited, or null when creating. */
  private readonly existing: CalendarEventData | null;
  private existingRepeat: RecurrenceFrequency | null = null;

  constructor(
    private readonly onSaved: () => void,
    existing?: CalendarEventData
  ) {
    this.existing = existing ?? null;
    this.isPrivate = existing?.isPrivate ?? false;
    if (existing?.rrule) {
      this.existingRepeat = parseRecurrenceRule(existing.rrule).frequency;
    }
    this.repeatValue = this.existingRepeat;
  }

  public open(): void {
    const content = document.createElement('div');
    content.className = 'calendar-addon-editor';

    const draft = this.initialDraft();
    content.innerHTML = `
      <div class="form__row">
        <label for="cal-editor-title">Title</label>
        <input id="cal-editor-title" class="input input--title" type="text" maxlength="200" placeholder="Event title" value="${escapeHtmlAttr(draft.title)}" />
      </div>
      <div class="form__row">
        <div id="cal-editor-allday"></div>
      </div>
      <div class="form__row">
        <div id="cal-editor-private"></div>
      </div>
      <div class="form__row" data-when="timed">
        <label for="cal-editor-start">Starts</label>
        <input id="cal-editor-start" class="input" type="datetime-local" />
      </div>
      <div class="form__row" data-when="timed">
        <label for="cal-editor-end">Ends (optional)</label>
        <input id="cal-editor-end" class="input" type="datetime-local" />
      </div>
      <div class="form__row" data-when="allday" hidden>
        <label for="cal-editor-start-date">Start date</label>
        <input id="cal-editor-start-date" class="datepicker" type="date" />
      </div>
      <div class="form__row" data-when="allday" hidden>
        <label for="cal-editor-end-date">End date (optional, exclusive)</label>
        <input id="cal-editor-end-date" class="datepicker" type="date" />
      </div>
      <div class="form__row">
        <label for="cal-editor-location">Location</label>
        <input id="cal-editor-location" class="input" type="text" maxlength="300" placeholder="Address, link, room…" value="${escapeHtmlAttr(draft.location)}" />
      </div>
      <div class="form__row" data-private-only hidden>
        <label for="cal-editor-participants">Participants (private invites)</label>
        <input id="cal-editor-participants" class="input" type="text" placeholder="npub or hex pubkey, comma-separated" value="${escapeHtmlAttr((this.existing?.participants ?? []).join(', '))}" />
        <p class="form__note" data-editor-note>They receive an encrypted invitation containing the event's view key.</p>
      </div>
      <div class="form__row">
        <label>Repeat</label>
        <div id="cal-editor-repeat"></div>
      </div>
      <div class="form__row">
        <label for="cal-editor-desc">Description</label>
        <textarea id="cal-editor-desc" class="textarea textarea--small" maxlength="5000" placeholder="Details (visible to everyone — this is a public event)">${escapeHtmlAttr(draft.description)}</textarea>
      </div>
      <p class="form__note" data-editor-note>${
        this.isPrivate
          ? 'Private event: NIP-44-encrypted, only readable by you. Syncs across your devices via your relays.'
          : 'Public event: everyone on Nostr can read it.'
      }</p>
      <div class="calendar-addon-editor__actions l-row--end-pair">
        ${
          this.existing
            ? '<button class="btn btn--danger btn--medium" type="button" data-action="delete">Delete</button>'
            : ''
        }
        <button class="btn btn--medium" type="button" data-action="save">${this.existing ? 'Save changes' : 'Create event'}</button>
      </div>
    `;

    // Fill time inputs AFTER innerHTML (values were not expressible inline
    // for datetime-local across browsers).
    const startInput =
      content.querySelector<HTMLInputElement>('#cal-editor-start')!;
    const endInput =
      content.querySelector<HTMLInputElement>('#cal-editor-end')!;
    const startDateInput = content.querySelector<HTMLInputElement>(
      '#cal-editor-start-date'
    )!;
    const endDateInput = content.querySelector<HTMLInputElement>(
      '#cal-editor-end-date'
    )!;
    if (draft.allDay) {
      startDateInput.value = toLocalDateInput(draft.startMs);
      if (draft.endMs !== null)
        endDateInput.value = toLocalDateInput(draft.endMs);
    } else {
      startInput.value = toDatetimeLocal(draft.startMs);
      if (draft.endMs !== null) endInput.value = toDatetimeLocal(draft.endMs);
    }

    // All-day switch.
    this.allDaySwitch = new Switch({
      label: 'All-day event',
      checked: draft.allDay,
      onChange: checked => this.toggleAllDay(content, checked),
    });
    content.querySelector('#cal-editor-allday')!.innerHTML =
      this.allDaySwitch.render();
    this.allDaySwitch.setupEventListeners(content);
    this.applyWhenVisibility(content, draft.allDay);

    // Privacy: Switch on create; locked badge while editing (public/private
    // events cannot be converted — different kinds on the wire).
    if (!this.existing) {
      this.privateSwitch = new Switch({
        label: 'Private (encrypted)',
        checked: false,
        onChange: checked => {
          this.isPrivate = checked;
          this.applyPrivateVisibility(content, checked);
          const note =
            content.querySelector<HTMLParagraphElement>('[data-editor-note]');
          if (note) {
            note.textContent = checked
              ? 'Private event: NIP-44-encrypted, only readable by you. Syncs across your devices via your relays.'
              : 'Public event: everyone on Nostr can read it.';
          }
        },
      });
      const privateSlot = content.querySelector('#cal-editor-private');
      if (privateSlot) {
        privateSlot.innerHTML = this.privateSwitch.render();
        this.privateSwitch.setupEventListeners(content);
      }
      this.applyPrivateVisibility(content, this.isPrivate);
    } else if (this.isPrivate) {
      const privateSlot = content.querySelector('#cal-editor-private');
      if (privateSlot) {
        privateSlot.innerHTML =
          '<span class="badge">Private (encrypted)</span>';
      }
    }

    // Repeat dropdown.
    this.repeatDropdown = new CustomDropdown({
      options: REPEAT_OPTIONS,
      selectedValue: this.repeatValue ?? 'none',
      width: '100%',
      onChange: value => {
        this.repeatValue =
          value === 'none' ? null : (value as RecurrenceFrequency);
      },
    });
    content
      .querySelector('#cal-editor-repeat')!
      .appendChild(this.repeatDropdown.getElement());

    // Actions.
    content
      .querySelector('[data-action="save"]')
      ?.addEventListener('click', () => {
        void this.save(content);
      });
    content
      .querySelector('[data-action="delete"]')
      ?.addEventListener('click', () => {
        void this.remove();
      });

    ModalService.getInstance().show({
      title: this.existing ? 'Edit event' : 'New calendar event',
      content,
      width: '520px',
      onClose: () => this.destroy(),
    });
  }

  private initialDraft(): CalendarEventDraft {
    if (this.existing) {
      const location = this.existing.locations[0] ?? '';
      return {
        dTag: this.existing.dTag,
        allDay: this.existing.allDay,
        title: this.existing.title,
        description: this.existing.description,
        startMs: this.existing.startMs,
        endMs: this.existing.endMs,
        location,
        image: this.existing.image ?? '',
        repeat: this.existingRepeat,
      };
    }
    // Default: next full hour, 1 hour long.
    const now = new Date();
    const start = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      now.getHours() + 1
    );
    return {
      dTag: generateDTag(),
      allDay: false,
      title: '',
      description: '',
      startMs: start.getTime(),
      endMs: start.getTime() + 3600_000,
      location: '',
      image: '',
      repeat: null,
    };
  }

  private toggleAllDay(content: HTMLElement, allDay: boolean): void {
    // Carry the date across modes so the user does not lose their input.
    const timedStart =
      content.querySelector<HTMLInputElement>('#cal-editor-start')!;
    const startDate = content.querySelector<HTMLInputElement>(
      '#cal-editor-start-date'
    )!;
    if (allDay) {
      if (timedStart.value) {
        startDate.value = timedStart.value.slice(0, 10);
      } else {
        startDate.value = toLocalDateInput(Date.now());
      }
    } else if (startDate.value) {
      const previous = timedStart.value;
      timedStart.value = `${startDate.value}T${previous.slice(11, 16) || '09:00'}`;
    }
    this.applyWhenVisibility(content, allDay);
  }

  private applyWhenVisibility(content: HTMLElement, allDay: boolean): void {
    content.querySelectorAll<HTMLElement>('[data-when="timed"]').forEach(el => {
      el.hidden = allDay;
    });
    content
      .querySelectorAll<HTMLElement>('[data-when="allday"]')
      .forEach(el => {
        el.hidden = !allDay;
      });
  }

  /** Show/hide the participants row (private events only). */
  private applyPrivateVisibility(
    content: HTMLElement,
    isPrivate: boolean
  ): void {
    content.querySelectorAll<HTMLElement>('[data-private-only]').forEach(el => {
      el.hidden = !isPrivate;
    });
  }

  private readDraft(content: HTMLElement): CalendarEventDraft {
    const title =
      content.querySelector<HTMLInputElement>('#cal-editor-title')!.value;
    const description =
      content.querySelector<HTMLTextAreaElement>('#cal-editor-desc')!.value;
    const location = content.querySelector<HTMLInputElement>(
      '#cal-editor-location'
    )!.value;
    const allDay = this.allDaySwitch?.isChecked() ?? false;

    let startMs: number;
    let endMs: number | null;
    if (allDay) {
      const startDate = content.querySelector<HTMLInputElement>(
        '#cal-editor-start-date'
      )!.value;
      const endDate = content.querySelector<HTMLInputElement>(
        '#cal-editor-end-date'
      )!.value;
      startMs = Date.parse(`${startDate}T00:00:00Z`);
      endMs = endDate ? Date.parse(`${endDate}T00:00:00Z`) : null;
    } else {
      const startRaw =
        content.querySelector<HTMLInputElement>('#cal-editor-start')!.value;
      const endRaw =
        content.querySelector<HTMLInputElement>('#cal-editor-end')!.value;
      startMs = startRaw ? new Date(startRaw).getTime() : NaN;
      endMs = endRaw ? new Date(endRaw).getTime() : null;
    }

    return {
      dTag: this.existing?.dTag ?? generateDTag(),
      allDay,
      title,
      description,
      startMs,
      endMs,
      location,
      image: this.existing?.image ?? '',
      repeat: this.repeatValue,
    };
  }

  private async save(content: HTMLElement): Promise<void> {
    const draft = this.readDraft(content);
    if (!draft.title.trim()) {
      ToastService.show('Please enter a title', 'warning');
      return;
    }
    if (!Number.isFinite(draft.startMs)) {
      ToastService.show('Please pick a valid start', 'warning');
      return;
    }

    const saveBtn = content.querySelector<HTMLButtonElement>(
      '[data-action="save"]'
    )!;
    saveBtn.disabled = true;
    try {
      if (this.isPrivate) {
        const { PrivateCalendarService } = await import(
          './PrivateCalendarService'
        );
        const participants = this.readParticipants(content);
        const previous = new Set(this.existing?.participants ?? []);
        const model =
          await PrivateCalendarService.getInstance().publishPrivateEvent({
            dTag: draft.dTag,
            title: draft.title.trim(),
            description: draft.description.trim(),
            startMs: draft.startMs,
            endMs: draft.endMs,
            location: draft.location.trim(),
            image: draft.image.trim(),
            rrule: draft.repeat
              ? buildRecurrenceRule({
                  frequency: draft.repeat,
                  startMs: draft.startMs,
                })
              : null,
            participants,
          });
        // Phase 3b: gift-wrap invitations for new participants.
        const newParticipants = participants.filter(p => p && !previous.has(p));
        if (newParticipants.length > 0) {
          const { CalendarInviteService } = await import(
            './CalendarInviteService'
          );
          await CalendarInviteService.getInstance().sendInvites(
            model,
            newParticipants,
            ''
          );
        }
      } else {
        const { CalendarPublishService } = await import(
          './CalendarPublishService'
        );
        await CalendarPublishService.getInstance().publishEvent(draft);
      }
      ToastService.show(
        this.existing ? 'Event updated' : 'Event published',
        'success'
      );
      ModalService.getInstance().hide();
      this.onSaved();
    } catch (error) {
      ErrorService.handle(
        error,
        'CalendarEventEditor.save',
        true,
        'Could not save the event'
      );
      saveBtn.disabled = false;
    }
  }

  private async remove(): Promise<void> {
    if (!this.existing) return;
    const confirmed = await ModalService.getInstance().confirm({
      title: 'Delete event',
      message: `Delete "${this.existing.title || 'this event'}"${this.isPrivate ? '' : ' for everyone'}? A deletion request is published to relays.`,
      confirmText: 'Delete',
      confirmDestructive: true,
    });
    if (!confirmed) return;

    try {
      const ok = this.isPrivate
        ? await (
            await import('./PrivateCalendarService')
          ).PrivateCalendarService.getInstance().deletePrivateEvent(
            this.existing
          )
        : await (
            await import('./CalendarPublishService')
          ).CalendarPublishService.getInstance().deleteEvent(this.existing);
      if (!ok) {
        ToastService.show('Deletion was not acknowledged', 'warning');
        return;
      }
      ToastService.show('Event deleted', 'success');
      ModalService.getInstance().hide();
      this.onSaved();
    } catch (error) {
      ErrorService.handle(
        error,
        'CalendarEventEditor.remove',
        true,
        'Could not delete the event'
      );
    }
  }

  /** Parse the participants input: comma/whitespace-separated npub or hex. */
  private readParticipants(content: HTMLElement): string[] {
    const raw =
      content.querySelector<HTMLInputElement>('#cal-editor-participants')
        ?.value ?? '';
    const out: string[] = [];
    for (const token of raw.split(/[,\s]+/)) {
      const value = token.trim();
      if (!value) continue;
      if (/^[0-9a-f]{64}$/i.test(value)) {
        out.push(value.toLowerCase());
        continue;
      }
      try {
        const decoded = decodeNip19(
          value.startsWith('nostr:') ? value.slice(6) : value
        );
        if (decoded.type === 'npub') {
          // nostr-tools decodes npub data as a hex string.
          out.push(String(decoded.data).toLowerCase());
        }
      } catch {
        // Ignore malformed tokens — the field is optional.
      }
    }
    return [...new Set(out)];
  }

  public destroy(): void {
    this.repeatDropdown?.destroy();
    this.repeatDropdown = null;
    this.allDaySwitch = null;
  }
}
