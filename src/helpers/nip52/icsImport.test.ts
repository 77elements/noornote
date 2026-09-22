/**
 * Tests for icsImport.ts — serverless .ics import for the Personal calendar.
 * Fixtures are timezone-independent (UTC-based) except the TZID case, which
 * uses a fixed-offset timezone via Intl.
 */

import { describe, it, expect } from 'vitest';
import {
  parseICSCalendar,
  filterCandidatesByRange,
  candidateToDraftFields,
  deriveImportDTag,
} from './icsImport';

const SIMPLE = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:1',
  'DTSTART:20261001T090000Z',
  'DTEND:20261001T100000Z',
  'SUMMARY:Standup',
  'DESCRIPTION:Daily sync',
  'LOCATION:https://meet.example/x',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('parseICSCalendar', () => {
  it('parses a simple UTC VEVENT', () => {
    const result = parseICSCalendar(SIMPLE, 'UTC');
    expect(result.candidates).toHaveLength(1);
    const c = result.candidates[0]!;
    expect(c.title).toBe('Standup');
    expect(c.description).toBe('Daily sync');
    expect(c.location).toBe('https://meet.example/x');
    expect(c.startMs).toBe(Date.UTC(2026, 9, 1, 9, 0, 0));
    expect(c.endMs).toBe(Date.UTC(2026, 9, 1, 10, 0, 0));
    expect(c.allDay).toBe(false);
    expect(result.failed).toBe(0);
    expect(result.cancelled).toBe(0);
  });

  it('unfolds folded DESCRIPTION lines and unescapes text', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:1',
      'DTSTART:20261001T090000Z',
      'SUMMARY:Multi\\nline',
      'DESCRIPTION:line one\n  line two with\\, comma and\\\\slash',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const result = parseICSCalendar(ics, 'UTC');
    const c = result.candidates[0]!;
    expect(c.description).toContain('line one');
    expect(c.description).toContain('line two with, comma and\\slash');
    expect(c.title).toBe('Multi\nline');
  });

  it('handles TZID values (Europe/Berlin, DST-aware)', () => {
    // 2026-07-01 19:00 Berlin (CEST, UTC+2) → 17:00 UTC.
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:1',
      'DTSTART;TZID=Europe/Berlin:20260701T190000',
      'DTEND;TZID=Europe/Berlin:20260701T200000',
      'SUMMARY:Berlin meeting',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const result = parseICSCalendar(ics, 'UTC');
    expect(result.candidates[0]!.startMs).toBe(Date.UTC(2026, 6, 1, 17, 0, 0));
  });

  it('parses all-day DATE values as kind 31922 candidates', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:1',
      'DTSTART;VALUE=DATE:20261001',
      'SUMMARY:All-day event',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const result = parseICSCalendar(ics, 'UTC');
    expect(result.candidates[0]!.allDay).toBe(true);
    expect(result.candidates[0]!.startMs).toBe(Date.UTC(2026, 9, 1));
  });

  it('parses RRULE series with COUNT', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:1',
      'DTSTART:20261001T090000Z',
      'DTEND:20261001T100000Z',
      'RRULE:FREQ=DAILY;COUNT=5',
      'SUMMARY:Series',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const result = parseICSCalendar(ics, 'UTC');
    expect(result.candidates[0]!.rrule).toBe('FREQ=DAILY;COUNT=5');
    expect(result.candidates[0]!.recurrence.frequency).toBe('daily');
    expect(result.candidates[0]!.recurrence.count).toBe(5);
  });

  it('skips STATUS:CANCELLED events', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:1',
      'DTSTART:20261001T090000Z',
      'STATUS:CANCELLED',
      'SUMMARY:Gone',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const result = parseICSCalendar(ics, 'UTC');
    expect(result.candidates).toHaveLength(0);
    expect(result.cancelled).toBe(1);
  });

  it('counts unparsable VEVENTs as failed without dropping the rest', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:bad',
      'SUMMARY:No dates at all',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:2',
      'DTSTART:20261001T090000Z',
      'SUMMARY:Valid',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const result = parseICSCalendar(ics, 'UTC');
    expect(result.failed).toBe(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.title).toBe('Valid');
  });
});

describe('filterCandidatesByRange', () => {
  const oct1 = Date.UTC(2026, 9, 1, 9, 0, 0);
  const nov1 = Date.UTC(2026, 10, 1, 9, 0, 0);
  const mk = (uid: string, startMs: number, rrule?: string) => ({
    dTag: uid,
    title: uid,
    description: '',
    location: '',
    startMs,
    endMs: startMs + 3_600_000,
    allDay: false,
    rrule: rrule ?? null,
    recurrence: rrule
      ? {
          frequency: 'weekly' as const,
          endMode: 'never' as const,
          count: null,
          untilMs: null,
        }
      : null,
  });

  it('keeps events inside the range and drops the rest', () => {
    const candidates = [mk('a', oct1), mk('b', nov1)];
    const { inRange, outOfRange } = filterCandidatesByRange(
      candidates,
      Date.UTC(2026, 9, 1),
      Date.UTC(2026, 9, 30)
    );
    expect(inRange.map(c => c.dTag)).toEqual(['a']);
    expect(outOfRange).toBe(1);
  });

  it('keeps a series whose occurrences fall inside the range', () => {
    // Weekly series starting before the range — expansion hits the range.
    const series = mk('series', Date.UTC(2026, 8, 1, 9), 'FREQ=WEEKLY');
    const { inRange } = filterCandidatesByRange(
      [series],
      Date.UTC(2026, 9, 1),
      Date.UTC(2026, 9, 30)
    );
    expect(inRange).toHaveLength(1);
  });

  it('returns everything when no range is set', () => {
    const candidates = [mk('a', oct1), mk('b', nov1)];
    expect(
      filterCandidatesByRange(candidates, null, null).inRange
    ).toHaveLength(2);
  });
});

describe('candidateToDraftFields', () => {
  const c = {
    dTag: 'abc',
    title: 'Standup',
    description: 'desc',
    location: 'Zoom',
    startMs: Date.UTC(2026, 9, 1, 9),
    endMs: Date.UTC(2026, 9, 1, 10),
    allDay: false,
    rrule: 'FREQ=DAILY;COUNT=5',
    recurrence: {
      frequency: 'daily' as const,
      endMode: 'count' as const,
      count: 5,
      untilMs: null,
    },
  };

  it('maps all draft fields incl. rruleOverride', () => {
    const fields = candidateToDraftFields(c);
    expect(fields.title).toBe('Standup');
    expect(fields.description).toBe('desc');
    expect(fields.location).toBe('Zoom');
    expect(fields.startMs).toBe(c.startMs);
    expect(fields.endMs).toBe(c.endMs);
    expect(fields.allDay).toBe(false);
    expect(fields.repeat).toBe('daily');
    // COUNT is preserved via the override (publishEvent would normalize it away).
    expect(fields.rruleOverride).toBe('FREQ=DAILY;COUNT=5');
  });
});

describe('deriveImportDTag', () => {
  it('is deterministic: same UID → same d-tag across calls and processes', () => {
    const a = deriveImportDTag(
      'uid-1@example.com',
      'Lunch',
      1790701200000,
      false
    );
    const b = deriveImportDTag(
      'uid-1@example.com',
      'Lunch',
      1790701200000,
      false
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^ics-[a-z0-9]{16}$/);
  });

  it('differs for different UIDs (no collision on identical titles)', () => {
    const a = deriveImportDTag(
      'uid-1@example.com',
      'Lunch',
      1790701200000,
      false
    );
    const b = deriveImportDTag(
      'uid-2@example.com',
      'Lunch',
      1790701200000,
      false
    );
    expect(a).not.toBe(b);
  });

  it('falls back to a content hash when the VEVENT has no UID', () => {
    const a = deriveImportDTag('', 'Lunch', 1790701200000, false);
    const b = deriveImportDTag('', 'Lunch', 1790701200000, false);
    const c = deriveImportDTag('', 'Lunch', 1790701200000, true);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('keeps the d-tag colon-free even when the UID contains colons', () => {
    const dTag = deriveImportDTag(
      '31923:abc123:bookslot-1790701200',
      'Slot',
      1790701200000,
      false
    );
    expect(dTag).not.toContain(':');
  });

  it('parses the same file twice to identical d-tags (idempotent re-import)', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:stable-uid@example.com',
      'DTSTAMP:20260917T160814Z',
      'DTSTART:20260917T163000Z',
      'DTEND:20260917T180000Z',
      'SUMMARY:Test Event',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const first = parseICSCalendar(ics, 'UTC');
    const second = parseICSCalendar(ics, 'UTC');
    expect(first.candidates[0]!.dTag).toBe(second.candidates[0]!.dTag);
    expect(first.candidates[0]!.dTag).toMatch(/^ics-[a-z0-9]{16}$/);
  });
});
