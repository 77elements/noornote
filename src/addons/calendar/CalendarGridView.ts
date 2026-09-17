/**
 * CalendarGridView - month / week / list grid over the user's NIP-52 events.
 *
 * Data comes from CalendarDataService (own events, cached + fetched).
 * Recurring events (NIP-52R) are expanded per visible range via
 * recurrence.getOccurrencesInRange. Clicking an event opens the detail modal.
 */

import { escapeHtml } from '../../helpers/escapeHtml';
import { setupTabClickHandlers } from '../../helpers/TabsHelper';
import { ToastService } from '../../services/ToastService';
import { CalendarDataService } from './CalendarDataService';
import { CalendarEventModal } from './CalendarEventModal';
import {
  parseCalendarEvent,
  type CalendarEventData,
} from '../../helpers/nip52/parser';
import { getOccurrencesInRange } from '../../helpers/nip52/recurrence';
import type { CalendarInvite } from './CalendarInviteService';

type GridMode = 'month' | 'week' | 'list';

interface GridEntry {
  event: CalendarEventData;
  occurrenceStartMs: number;
}

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export class CalendarGridView {
  private container: HTMLElement;
  private dataService: CalendarDataService;
  private mode: GridMode = 'month';
  /** Anchor date (UTC midnight of the visible day). */
  private anchorDate: Date;
  private entries: GridEntry[] = [];
  private invites: CalendarInvite[] = [];
  private loading = false;

  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'calendar-addon';
    this.anchorDate = this.startOfDay(new Date());
    this.dataService = CalendarDataService.getInstance();
    this.render();
    void this.load();
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.container.innerHTML = '';
  }

  // ---------- data ----------

  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      // Instant render from cache, then refresh from relays.
      this.ingest(this.dataService.getCachedEvents());
      const [{ events, collections }, invites, subscribed] = await Promise.all([
        this.dataService.fetchOwnCalendarData(),
        this.fetchInvites(),
        this.dataService.fetchSubscribedCollectionData().catch(() => ({
          collections: [],
          events: [],
        })),
      ]);
      this.invites = invites;
      this.loading = false;
      this.ingest([...events, ...subscribed.events]);

      // Collections (31924) can reference foreign events — pull those in so
      // subscribed public calendars show up in the grid too.
      const foreign = await this.fetchReferencedForeignEvents(
        events,
        collections
      );
      this.ingest([...events, ...subscribed.events, ...foreign]);
    } finally {
      this.loading = false;
    }
  }

  /** Phase 3b: received private-event invitations (gift wraps). */
  private async fetchInvites(): Promise<CalendarInvite[]> {
    try {
      const { CalendarInviteService } = await import('./CalendarInviteService');
      return await CalendarInviteService.getInstance().fetchInvites();
    } catch {
      return [];
    }
  }

  /** Accept an invitation: import into the private list + dismiss the wrap. */
  private async acceptInvite(invite: CalendarInvite): Promise<void> {
    try {
      const { CalendarInviteService } = await import('./CalendarInviteService');
      await CalendarInviteService.getInstance().acceptInvite(invite);
      ToastService.show('Invitation accepted', 'success');
      this.invites = this.invites.filter(
        candidate => candidate.wrapId !== invite.wrapId
      );
      this.render();
      void this.load();
    } catch {
      ToastService.show('Could not accept invitation', 'error');
    }
  }

  private async dismissInvite(invite: CalendarInvite): Promise<void> {
    try {
      const { CalendarInviteService } = await import('./CalendarInviteService');
      await CalendarInviteService.getInstance().dismiss(invite);
    } finally {
      this.invites = this.invites.filter(
        candidate => candidate.wrapId !== invite.wrapId
      );
      this.render();
    }
  }

  /** Fetch non-own events referenced by the user's collections. */
  private async fetchReferencedForeignEvents(
    ownEvents: CalendarEventData[],
    collections: { eventRefs: string[] }[]
  ): Promise<CalendarEventData[]> {
    const ownCoords = new Set(ownEvents.map(ev => ev.coordinate));
    const refs = new Set<string>();
    for (const col of collections) {
      for (const ref of col.eventRefs) {
        if (!ownCoords.has(ref)) refs.add(ref);
      }
    }
    if (refs.size === 0) return [];

    // Group refs by (kind, author) → one filter per group keeps the number
    // of relay round-trips low; `#d` carries the d-tags.
    const groups = new Map<
      string,
      { kind: number; author: string; dTags: string[] }
    >();
    for (const ref of refs) {
      const [kindStr, author, ...rest] = ref.split(':');
      const dTag = rest.join(':');
      const kind = Number(kindStr);
      if (!author || !dTag || !Number.isFinite(kind)) continue;
      const key = `${kind}:${author}`;
      const group = groups.get(key) ?? { kind, author, dTags: [] };
      group.dTags.push(dTag);
      groups.set(key, group);
    }

    const parsed: CalendarEventData[] = [];
    for (const group of groups.values()) {
      const raw = await this.dataService.fetchForeignEvents(
        group.author,
        [group.kind],
        group.dTags
      );
      for (const ev of raw) {
        const parsedEvent = parseCalendarEvent(ev);
        if (parsedEvent) parsed.push(parsedEvent);
      }
    }
    return parsed;
  }

  private ingest(events: CalendarEventData[]): void {
    this.entries = events.map(event => ({
      event,
      occurrenceStartMs: event.startMs,
    }));
    this.render();
  }

  // ---------- rendering ----------

  private render(): void {
    this.container.innerHTML = '';

    const toolbar = document.createElement('div');
    toolbar.className = 'calendar-addon__toolbar';
    toolbar.innerHTML = `
      <div class="calendar-addon__toolbar-nav">
        <div class="calendar-addon__nav">
          <button class="btn-icon" type="button" data-action="prev" aria-label="Previous">‹</button>
          <button class="btn btn--passive btn--mini" type="button" data-action="today">Today</button>
          <button class="btn-icon" type="button" data-action="next" aria-label="Next">›</button>
        </div>
        <span class="calendar-addon__range">${escapeHtml(this.rangeLabel())}</span>
      </div>
      <div class="tabs calendar-addon__tabs">
        <button class="tab${this.mode === 'month' ? ' tab--active' : ''}" data-tab="month" type="button">Month</button>
        <button class="tab${this.mode === 'week' ? ' tab--active' : ''}" data-tab="week" type="button">Week</button>
        <button class="tab${this.mode === 'list' ? ' tab--active' : ''}" data-tab="list" type="button">List</button>
      </div>
      <div class="l-row--right calendar-addon__toolbar-actions">
        <button class="btn btn--passive btn--mini" type="button" data-action="calendars">Calendars</button>
        <button class="btn btn--mini" type="button" data-action="new">+ New Event</button>
      </div>
    `;
    this.container.appendChild(toolbar);

    toolbar
      .querySelector('[data-action="prev"]')
      ?.addEventListener('click', () => this.navigate(-1));
    toolbar
      .querySelector('[data-action="next"]')
      ?.addEventListener('click', () => this.navigate(1));
    toolbar
      .querySelector('[data-action="today"]')
      ?.addEventListener('click', () => {
        this.anchorDate = this.startOfDay(new Date());
        this.render();
      });
    toolbar
      .querySelector('[data-action="calendars"]')
      ?.addEventListener('click', () => {
        void this.openCollections();
      });
    toolbar
      .querySelector('[data-action="new"]')
      ?.addEventListener('click', () => {
        void this.openEditor();
      });
    setupTabClickHandlers(toolbar, tabId => {
      this.mode = tabId as GridMode;
      this.render();
    });

    const body = document.createElement('div');
    body.className = 'calendar-addon__body';
    body.dataset.mode = this.mode;
    this.container.appendChild(body);

    if (this.invites.length > 0) {
      this.container.insertBefore(this.buildInviteBanner(), body);
    }
    this.renderBody(body);
  }

  /** Phase 3b: received private-event invitations. */
  private buildInviteBanner(): HTMLElement {
    const banner = document.createElement('div');
    banner.className = 'calendar-addon__invites';
    banner.innerHTML = `<div class="calendar-addon__invites-title">Invitations (${this.invites.length})</div>`;
    for (const invite of this.invites) {
      const row = document.createElement('div');
      row.className = 'calendar-addon__invite';
      row.innerHTML = `
        <span class="calendar-addon__invite-message">${escapeHtml(
          invite.message || invite.coordinate
        )}</span>
        <span class="l-row">
          <button class="btn btn--success btn--mini" type="button" data-action="accept">Accept</button>
          <button class="btn btn--passive btn--mini" type="button" data-action="dismiss">Dismiss</button>
        </span>
      `;
      row
        .querySelector('[data-action="accept"]')
        ?.addEventListener('click', () => {
          void this.acceptInvite(invite);
        });
      row
        .querySelector('[data-action="dismiss"]')
        ?.addEventListener('click', () => {
          void this.dismissInvite(invite);
        });
      banner.appendChild(row);
    }
    return banner;
  }

  private renderBody(body?: HTMLElement): void {
    const target =
      body ??
      this.container.querySelector<HTMLElement>('.calendar-addon__body');
    if (!target) return;
    target.innerHTML = '';

    if (this.loading && this.entries.length === 0) {
      const loading = document.createElement('div');
      loading.className = 'calendar-addon__loading pulsate';
      loading.textContent = 'Loading calendar…';
      target.appendChild(loading);
      return;
    }

    if (this.mode === 'month') target.appendChild(this.buildMonthGrid());
    else if (this.mode === 'week') target.appendChild(this.buildWeekGrid());
    else target.appendChild(this.buildList());

    if (this.uniqueEvents().length === 0 && !this.loading) {
      const empty = document.createElement('div');
      empty.className = 'calendar-addon__empty';
      empty.textContent =
        'No events yet. Create one — or find a public event calendar and hit Subscribe to fill your grid.';
      target.appendChild(empty);
    }
  }

  private buildMonthGrid(): HTMLElement {
    const grid = document.createElement('div');
    grid.className = 'calendar-addon__month';
    grid.innerHTML = WEEKDAY_LABELS.map(
      label => `<div class="calendar-addon__weekday">${label}</div>`
    ).join('');

    const [start, end] = this.monthRange();
    const byDay = this.entriesByDay(start, end);

    // 6 rows × 7 days starting Monday.
    const firstCell = this.addDays(start, -((start.getDay() + 6) % 7));
    for (let i = 0; i < 42; i++) {
      const day = this.addDays(firstCell, i);
      const inMonth = day.getMonth() === this.anchorDate.getMonth();
      const cell = document.createElement('div');
      cell.className = `calendar-addon__day${inMonth ? '' : ' calendar-addon__day--outside'}`;
      cell.innerHTML = `<span class="calendar-addon__daynum">${day.getDate()}</span>`;
      const chips = document.createElement('div');
      chips.className = 'calendar-addon__chips';
      for (const entry of (byDay.get(day.getTime()) ?? []).slice(0, 3)) {
        chips.appendChild(this.buildChip(entry, true));
      }
      const total = (byDay.get(day.getTime()) ?? []).length;
      if (total > 3) {
        const more = document.createElement('span');
        more.className = 'calendar-addon__more';
        more.textContent = `+${total - 3} more`;
        chips.appendChild(more);
      }
      cell.appendChild(chips);
      grid.appendChild(cell);
    }
    return grid;
  }

  private buildWeekGrid(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'calendar-addon__week';
    const weekStart = this.addDays(
      this.anchorDate,
      -((this.anchorDate.getDay() + 6) % 7)
    );
    const rangeStart = weekStart.getTime();
    const rangeEnd = this.addDays(weekStart, 7).getTime() - 1;
    const byDay = this.entriesByDay(new Date(rangeStart), new Date(rangeEnd));

    for (let i = 0; i < 7; i++) {
      const day = this.addDays(weekStart, i);
      const col = document.createElement('div');
      col.className = 'calendar-addon__week-col';
      const isToday = day.getTime() === this.startOfDay(new Date()).getTime();
      col.innerHTML = `<div class="calendar-addon__weekday${isToday ? ' calendar-addon__weekday--today' : ''}">${WEEKDAY_LABELS[i]} ${day.getDate()}</div>`;
      const chips = document.createElement('div');
      chips.className = 'calendar-addon__chips';
      for (const entry of byDay.get(day.getTime()) ?? []) {
        chips.appendChild(this.buildChip(entry, false));
      }
      col.appendChild(chips);
      wrap.appendChild(col);
    }
    return wrap;
  }

  private buildList(): HTMLElement {
    const list = document.createElement('div');
    list.className = 'ui-list';
    const now = Date.now();
    const horizon = now + 60 * 24 * 3600 * 1000;
    const upcoming = this.expandRange(now, horizon).sort(
      (a, b) => a.occurrenceStartMs - b.occurrenceStartMs
    );

    for (const entry of upcoming) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className =
        'ui-list__item ui-list__item--clickable calendar-addon__list-row';
      row.innerHTML = `
        <span class="calendar-addon__list-date">${escapeHtml(this.formatListDate(entry.occurrenceStartMs))}</span>
        <span class="calendar-addon__list-title">${entry.event.isPrivate ? '🔒 ' : ''}${escapeHtml(entry.event.title || '(Untitled event)')}</span>
        <span class="calendar-addon__list-meta">${escapeHtml(this.timeLabel(entry))}</span>
      `;
      row.addEventListener('click', () => this.openDetail(entry));
      list.appendChild(row);
    }
    return list;
  }

  private buildChip(entry: GridEntry, compact: boolean): HTMLElement {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `calendar-addon__chip${entry.event.allDay ? ' calendar-addon__chip--allday' : ''}${entry.event.isPrivate ? ' calendar-addon__chip--private' : ''}`;
    chip.title = entry.event.title || '(Untitled event)';
    chip.innerHTML = compact
      ? escapeHtml(entry.event.title || '(Untitled)')
      : `<span class="calendar-addon__chip-time">${escapeHtml(this.timeLabel(entry))}</span><span>${escapeHtml(entry.event.title || '(Untitled event)')}</span>`;
    chip.addEventListener('click', e => {
      e.stopPropagation();
      this.openDetail(entry);
    });
    return chip;
  }

  private openDetail(entry: GridEntry): void {
    const modal = new CalendarEventModal(
      entry.event,
      entry.occurrenceStartMs,
      () => void this.load()
    );
    modal.open();
  }

  private async openEditor(): Promise<void> {
    const { CalendarEventEditor } = await import('./CalendarEventEditor');
    new CalendarEventEditor(() => void this.load()).open();
  }

  private openCollections(): void {
    void import('./CalendarCollectionsModal').then(
      ({ CalendarCollectionsModal }) => {
        new CalendarCollectionsModal(() => void this.load()).open();
      }
    );
  }

  // ---------- range helpers ----------

  private navigate(direction: -1 | 1): void {
    if (this.mode === 'month') {
      this.anchorDate = new Date(
        this.anchorDate.getFullYear(),
        this.anchorDate.getMonth() + direction,
        1
      );
    } else if (this.mode === 'week') {
      this.anchorDate = this.addDays(this.anchorDate, 7 * direction);
    }
    this.render();
  }

  private monthRange(): [Date, Date] {
    const start = new Date(
      this.anchorDate.getFullYear(),
      this.anchorDate.getMonth(),
      1
    );
    const end = new Date(
      this.anchorDate.getFullYear(),
      this.anchorDate.getMonth() + 1,
      0,
      23,
      59,
      59,
      999
    );
    return [start, end];
  }

  /** Expand all events (incl. recurrence) into [rangeStart, rangeEnd]. */
  private expandRange(rangeStartMs: number, rangeEndMs: number): GridEntry[] {
    const result: GridEntry[] = [];
    for (const event of this.uniqueEvents()) {
      for (const occurrenceStartMs of getOccurrencesInRange(
        event,
        rangeStartMs,
        rangeEndMs
      )) {
        result.push({ event, occurrenceStartMs });
      }
    }
    return result;
  }

  private uniqueEvents(): CalendarEventData[] {
    const byCoord = new Map<string, CalendarEventData>();
    for (const { event } of this.entries) {
      const existing = byCoord.get(event.coordinate);
      if (!existing || event.createdAt > existing.createdAt) {
        byCoord.set(event.coordinate, event);
      }
    }
    return [...byCoord.values()];
  }

  private entriesByDay(
    rangeStart: Date,
    rangeEnd: Date
  ): Map<number, GridEntry[]> {
    const map = new Map<number, GridEntry[]>();
    for (const entry of this.expandRange(
      rangeStart.getTime(),
      rangeEnd.getTime()
    )) {
      const dayKey = this.startOfDay(
        new Date(entry.occurrenceStartMs)
      ).getTime();
      const list = map.get(dayKey) ?? [];
      list.push(entry);
      map.set(dayKey, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.occurrenceStartMs - b.occurrenceStartMs);
    }
    return map;
  }

  private rangeLabel(): string {
    if (this.mode === 'month') {
      return this.anchorDate.toLocaleDateString(undefined, {
        month: 'long',
        year: 'numeric',
      });
    }
    if (this.mode === 'week') {
      const weekStart = this.addDays(
        this.anchorDate,
        -((this.anchorDate.getDay() + 6) % 7)
      );
      const weekEnd = this.addDays(weekStart, 6);
      const fmt = (d: Date) =>
        d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      return `${fmt(weekStart)} – ${fmt(weekEnd)}`;
    }
    return 'Upcoming';
  }

  private startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  private addDays(date: Date, days: number): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  }

  private timeLabel(entry: GridEntry): string {
    const { event } = entry;
    if (event.allDay) return 'All day';
    const start = new Date(entry.occurrenceStartMs).toLocaleTimeString(
      undefined,
      {
        hour: '2-digit',
        minute: '2-digit',
      }
    );
    if (event.endMs === null) return start;
    const duration = event.endMs - event.startMs;
    const end = new Date(entry.occurrenceStartMs + duration).toLocaleTimeString(
      undefined,
      { hour: '2-digit', minute: '2-digit' }
    );
    return `${start} – ${end}`;
  }

  private formatListDate(ms: number): string {
    return new Date(ms).toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
  }
}
