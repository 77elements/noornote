import { describe, it, expect } from 'vitest';
import {
  buildRecurrenceRule,
  getOccurrencesInRange,
  isEventInDateRange,
  parseRecurrenceRule,
  summarizeRecurrenceRule,
} from './recurrence';
import type { CalendarEventData } from './parser';

function makeEvent(overrides: Partial<CalendarEventData>): CalendarEventData {
  return {
    coordinate: '31923:pk:d',
    eventId: 'id',
    kind: 31923,
    pubkey: 'pk',
    dTag: 'd',
    title: 'Event',
    description: '',
    startMs: Date.UTC(2026, 0, 5, 9, 0, 0), // Mon 2026-01-05 09:00 UTC
    endMs: Date.UTC(2026, 0, 5, 10, 0, 0),
    allDay: false,
    locations: [],
    geoHashes: [],
    participants: [],
    hashtags: [],
    links: [],
    rrule: null,
    createdAt: 0,
    ...overrides,
  };
}

describe('parseRecurrenceRule', () => {
  it('maps the Form* frequency set', () => {
    expect(parseRecurrenceRule('FREQ=DAILY').frequency).toBe('daily');
    expect(parseRecurrenceRule('FREQ=WEEKLY').frequency).toBe('weekly');
    expect(
      parseRecurrenceRule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR').frequency
    ).toBe('weekdays');
    expect(parseRecurrenceRule('FREQ=MONTHLY').frequency).toBe('monthly');
    expect(parseRecurrenceRule('FREQ=MONTHLY;INTERVAL=3').frequency).toBe(
      'quarterly'
    );
    expect(parseRecurrenceRule('FREQ=YEARLY').frequency).toBe('yearly');
  });

  it('parses COUNT and UNTIL end modes', () => {
    const count = parseRecurrenceRule('FREQ=DAILY;COUNT=10');
    expect(count.endMode).toBe('count');
    expect(count.count).toBe(10);

    const until = parseRecurrenceRule('FREQ=DAILY;UNTIL=20260101T000000Z');
    expect(until.endMode).toBe('until');
    expect(until.untilMs).toBe(Date.UTC(2026, 0, 1));
  });

  it('accepts date-only UNTIL and tolerates the RRULE: prefix', () => {
    const parsed = parseRecurrenceRule('RRULE:FREQ=WEEKLY;UNTIL=20260201');
    expect(parsed.frequency).toBe('weekly');
    expect(parsed.untilMs).toBe(Date.UTC(2026, 1, 1));
  });

  it('returns empty for null / unknown rules', () => {
    expect(parseRecurrenceRule(null).frequency).toBeNull();
    expect(parseRecurrenceRule('FREQ=SECONDLY').frequency).toBeNull();
    expect(parseRecurrenceRule('').frequency).toBeNull();
  });
});

describe('buildRecurrenceRule', () => {
  it('builds bare rules with COUNT', () => {
    expect(
      buildRecurrenceRule({
        frequency: 'weekly',
        endMode: 'count',
        count: 10,
        startMs: 0,
      })
    ).toBe('FREQ=WEEKLY;COUNT=10');
  });

  it('aligns UNTIL to the event start time-of-day', () => {
    const rule = buildRecurrenceRule({
      frequency: 'daily',
      endMode: 'until',
      untilMs: Date.UTC(2026, 0, 20), // midnight — would cut the 09:00 occurrence
      startMs: Date.UTC(2026, 0, 5, 9, 30, 0),
    });
    expect(rule).toBe('FREQ=DAILY;UNTIL=20260120T093000Z');
  });
});

describe('getOccurrencesInRange', () => {
  const weekly = makeEvent({ rrule: 'FREQ=WEEKLY' });

  it('expands weekly occurrences inside the range', () => {
    // Jan 2026: 5th is a Monday → Mondays 5, 12, 19, 26.
    const occurrences = getOccurrencesInRange(
      weekly,
      Date.UTC(2026, 0, 1),
      Date.UTC(2026, 0, 31, 23, 59, 59)
    );
    expect(occurrences).toEqual([
      Date.UTC(2026, 0, 5, 9, 0, 0),
      Date.UTC(2026, 0, 12, 9, 0, 0),
      Date.UTC(2026, 0, 19, 9, 0, 0),
      Date.UTC(2026, 0, 26, 9, 0, 0),
    ]);
  });

  it('finds an occurrence whose occurrence overlaps the range via duration', () => {
    // Range starts during the second occurrence's 1h duration.
    const occurrences = getOccurrencesInRange(
      weekly,
      Date.UTC(2026, 0, 12, 9, 30, 0),
      Date.UTC(2026, 0, 20)
    );
    expect(occurrences).toContain(Date.UTC(2026, 0, 12, 9, 0, 0));
    expect(occurrences).toContain(Date.UTC(2026, 0, 19, 9, 0, 0));
  });

  it('non-recurring: yields start when the event overlaps the range', () => {
    const plain = makeEvent({});
    expect(
      getOccurrencesInRange(
        plain,
        Date.UTC(2026, 0, 5, 8, 0),
        Date.UTC(2026, 0, 5, 9, 30)
      )
    ).toEqual([Date.UTC(2026, 0, 5, 9, 0, 0)]);
    // Outside → empty.
    expect(
      getOccurrencesInRange(plain, Date.UTC(2026, 0, 6), Date.UTC(2026, 0, 7))
    ).toEqual([]);
    // Spanning range counts as overlap.
    expect(
      getOccurrencesInRange(
        plain,
        Date.UTC(2026, 0, 5, 9, 30),
        Date.UTC(2026, 0, 5, 9, 45)
      )
    ).toEqual([Date.UTC(2026, 0, 5, 9, 0, 0)]);
  });

  it('yearly recurrence expands across years', () => {
    const yearly = makeEvent({
      kind: 31922,
      allDay: true,
      startMs: Date.UTC(1990, 3, 15),
      endMs: null,
      rrule: 'FREQ=YEARLY',
    });
    const occurrences = getOccurrencesInRange(
      yearly,
      Date.UTC(2026, 0, 1),
      Date.UTC(2026, 11, 31)
    );
    expect(occurrences).toEqual([Date.UTC(2026, 3, 15)]);
  });
});

describe('isEventInDateRange', () => {
  it('is true when any occurrence intersects', () => {
    const weekly = makeEvent({ rrule: 'FREQ=WEEKLY' });
    expect(
      isEventInDateRange(
        weekly,
        Date.UTC(2026, 0, 19, 9, 30),
        Date.UTC(2026, 0, 19, 23)
      )
    ).toBe(true);
    expect(
      isEventInDateRange(
        weekly,
        Date.UTC(2026, 0, 19, 11),
        Date.UTC(2026, 0, 19, 12)
      )
    ).toBe(false);
  });
});

describe('summarizeRecurrenceRule', () => {
  it('humanizes supported frequencies and endings', () => {
    expect(summarizeRecurrenceRule('FREQ=DAILY;COUNT=5')).toBe('Daily, 5×');
    expect(summarizeRecurrenceRule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')).toBe(
      'Every weekday'
    );
  });
});
