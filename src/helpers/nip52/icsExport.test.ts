import { describe, it, expect } from 'vitest';
import { calendarEventToICS } from './icsExport';
import type { CalendarEventData } from './parser';

function makeEvent(overrides: Partial<CalendarEventData>): CalendarEventData {
  return {
    coordinate: '31923:pk:d',
    eventId: 'id',
    kind: 31923,
    pubkey: 'pk',
    dTag: 'd',
    title: 'Team Sync',
    description: '',
    startMs: Date.UTC(2026, 0, 5, 9, 0, 0),
    endMs: Date.UTC(2026, 0, 5, 10, 0, 0),
    allDay: false,
    locations: [],
    geoHashes: [],
    participants: [],
    hashtags: [],
    links: [],
    rrule: null,
    createdAt: 1_700_000_000,
    ...overrides,
  };
}

describe('calendarEventToICS', () => {
  it('exports timed events with UTC DTSTART/DTEND', () => {
    const ics = calendarEventToICS(makeEvent({}));
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('UID:31923:pk:d');
    expect(ics).toContain('DTSTART:20260105T090000Z');
    expect(ics).toContain('DTEND:20260105T100000Z');
    expect(ics).toContain('SUMMARY:Team Sync');
    expect(ics).toContain('END:VCALENDAR');
  });

  it('exports date-based events as all-day VALUE=DATE', () => {
    const ics = calendarEventToICS(
      makeEvent({
        kind: 31922,
        allDay: true,
        startMs: Date.UTC(2026, 6, 1),
        endMs: Date.UTC(2026, 6, 5),
      })
    );
    expect(ics).toContain('DTSTART;VALUE=DATE:20260701');
    expect(ics).toContain('DTEND;VALUE=DATE:20260705');
  });

  it('escapes special characters and newlines in text fields', () => {
    const ics = calendarEventToICS(
      makeEvent({
        title: 'Talk; Part 2, "revised"',
        description: 'line one\nline two',
        locations: ['Room 1, Building A'],
      })
    );
    expect(ics).toContain('SUMMARY:Talk\\; Part 2\\, "revised"');
    expect(ics).toContain('DESCRIPTION:line one\\nline two');
    expect(ics).toContain('LOCATION:Room 1\\, Building A');
  });

  it('uses CRLF line endings (RFC 5545)', () => {
    const ics = calendarEventToICS(makeEvent({}));
    expect(ics).toContain('\r\n');
    expect(ics.endsWith('\r\n')).toBe(true);
  });
});
