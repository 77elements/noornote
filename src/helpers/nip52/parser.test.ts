import { describe, it, expect } from 'vitest';
import {
  buildCalendarCoordinate,
  calendarEventToTags,
  parseCalendarCollection,
  parseCalendarEvent,
  toIsoDate,
} from './parser';

const baseEvent = {
  id: 'abc123',
  pubkey: 'pub456',
  created_at: 1_700_000_000,
};

describe('parseCalendarEvent (kind 31923, time-based)', () => {
  it('parses unix-second start/end into ms', () => {
    const event = parseCalendarEvent({
      ...baseEvent,
      kind: 31923,
      content: 'Team sync',
      tags: [
        ['d', 'team-sync'],
        ['title', 'Team Sync'],
        ['start', '1700000000'],
        ['end', '1700003600'],
        ['location', 'https://meet.example/x'],
        ['p', 'participant1'],
        ['t', 'work'],
      ],
    });

    expect(event).not.toBeNull();
    expect(event!.startMs).toBe(1_700_000_000_000);
    expect(event!.endMs).toBe(1_700_003_600_000);
    expect(event!.allDay).toBe(false);
    expect(event!.title).toBe('Team Sync');
    expect(event!.description).toBe('Team sync');
    expect(event!.locations).toEqual(['https://meet.example/x']);
    expect(event!.participants).toEqual(['participant1']);
    expect(event!.hashtags).toEqual(['work']);
    expect(event!.coordinate).toBe('31923:pub456:team-sync');
    expect(event!.rrule).toBeNull();
  });

  it('falls back to the deprecated name tag when title is missing', () => {
    const event = parseCalendarEvent({
      ...baseEvent,
      kind: 31923,
      content: '',
      tags: [
        ['d', 'x'],
        ['name', 'Legacy Name'],
        ['start', '100'],
      ],
    });
    expect(event!.title).toBe('Legacy Name');
  });

  it('drops an end that is not after start (NIP-52)', () => {
    const event = parseCalendarEvent({
      ...baseEvent,
      kind: 31923,
      content: '',
      tags: [
        ['d', 'x'],
        ['start', '1000'],
        ['end', '1000'],
      ],
    });
    expect(event!.endMs).toBeNull();
  });

  it('returns null without a d tag or a valid start', () => {
    expect(
      parseCalendarEvent({
        ...baseEvent,
        kind: 31923,
        content: '',
        tags: [['start', '10']],
      })
    ).toBeNull();
    expect(
      parseCalendarEvent({
        ...baseEvent,
        kind: 31923,
        content: '',
        tags: [
          ['d', 'x'],
          ['start', 'not-a-number'],
        ],
      })
    ).toBeNull();
  });

  it('returns null for non-calendar kinds', () => {
    expect(
      parseCalendarEvent({
        ...baseEvent,
        kind: 1,
        content: '',
        tags: [['d', 'x']],
      })
    ).toBeNull();
  });
});

describe('parseCalendarEvent (kind 31922, date-based)', () => {
  it('parses ISO dates as UTC midnight and marks all-day', () => {
    const event = parseCalendarEvent({
      ...baseEvent,
      kind: 31922,
      content: 'Alice birthday',
      tags: [
        ['d', 'alice'],
        ['title', 'Alice'],
        ['start', '1990-04-15'],
      ],
    });

    expect(event!.allDay).toBe(true);
    expect(event!.startMs).toBe(Date.UTC(1990, 3, 15));
    expect(event!.endMs).toBeNull();
  });

  it('parses exclusive end dates', () => {
    const event = parseCalendarEvent({
      ...baseEvent,
      kind: 31922,
      content: '',
      tags: [
        ['d', 'trip'],
        ['start', '2026-07-01'],
        ['end', '2026-07-05'],
      ],
    });
    expect(event!.endMs).toBe(Date.UTC(2026, 6, 5));
  });
});

describe('NIP-52R rrule parsing', () => {
  it('reads the two-tag L/l form', () => {
    const event = parseCalendarEvent({
      ...baseEvent,
      kind: 31923,
      content: '',
      tags: [
        ['d', 'standup'],
        ['start', '1700000000'],
        ['L', 'rrule'],
        ['l', 'FREQ=WEEKLY;BYDAY=MO'],
      ],
    });
    expect(event!.rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
  });

  it('reads the full NIP-32 form with namespace on the l tag', () => {
    const event = parseCalendarEvent({
      ...baseEvent,
      kind: 31923,
      content: '',
      tags: [
        ['d', 'standup'],
        ['start', '1700000000'],
        ['L', 'rrule'],
        ['l', 'FREQ=DAILY', 'rrule'],
      ],
    });
    expect(event!.rrule).toBe('FREQ=DAILY');
  });
});

describe('parseCalendarCollection (kind 31924)', () => {
  it('parses title and a-tag refs', () => {
    const collection = parseCalendarCollection({
      ...baseEvent,
      kind: 31924,
      content: 'Conf talks',
      tags: [
        ['d', 'conf'],
        ['title', 'Conference'],
        ['a', '31923:pub1:talk1', 'wss://relay.example'],
        ['a', '31922:pub2:day2'],
      ],
    });
    expect(collection!.title).toBe('Conference');
    expect(collection!.eventRefs).toHaveLength(2);
    expect(collection!.eventRefs[0]).toBe('31923:pub1:talk1');
    expect(collection!.coordinate).toBe('31924:pub456:conf');
  });
});

describe('calendarEventToTags round-trip', () => {
  it('serializes kind 31923 back to unix seconds + rrule labels', () => {
    const parsed = parseCalendarEvent({
      ...baseEvent,
      kind: 31923,
      content: 'desc',
      tags: [
        ['d', 'ev'],
        ['title', 'Event'],
        ['start', '1700000000'],
        ['end', '1700003600'],
        ['p', 'p1'],
        ['L', 'rrule'],
        ['l', 'FREQ=DAILY'],
      ],
    })!;

    const tags = calendarEventToTags(parsed);
    expect(tags).toContainEqual(['d', 'ev']);
    expect(tags).toContainEqual(['title', 'Event']);
    expect(tags).toContainEqual(['start', '1700000000']);
    expect(tags).toContainEqual(['end', '1700003600']);
    expect(tags).toContainEqual(['L', 'rrule']);
    expect(tags).toContainEqual(['l', 'FREQ=DAILY']);
  });

  it('serializes kind 31922 back to ISO dates', () => {
    const parsed = parseCalendarEvent({
      ...baseEvent,
      kind: 31922,
      content: '',
      tags: [
        ['d', 'bd'],
        ['title', 'BD'],
        ['start', '1990-04-15'],
      ],
    })!;
    const tags = calendarEventToTags(parsed);
    expect(tags).toContainEqual(['start', '1990-04-15']);
    expect(tags).not.toContainEqual(['end', expect.anything()]);
  });
});

describe('helpers', () => {
  it('buildCalendarCoordinate joins kind/pubkey/dTag', () => {
    expect(buildCalendarCoordinate(31923, 'pk', 'dd')).toBe('31923:pk:dd');
  });

  it('toIsoDate formats UTC', () => {
    expect(toIsoDate(Date.UTC(2026, 8, 16))).toBe('2026-09-16');
  });
});
