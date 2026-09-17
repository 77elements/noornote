/**
 * NIP-52R recurrence — RRULE expansion for calendar events (31922/31923).
 *
 * Recurrence rides on the standard kinds via NIP-32 labels:
 *   ["L", "rrule"] ["l", "FREQ=WEEKLY;BYDAY=MO"]
 * Pure functions — ported from formstr-hq/nostr-calendar
 * `src/utils/repeatingEventsHelper.ts` (MIT), trimmed to what the grid needs.
 */

import { RRule } from 'rrule';
import type { CalendarEventData } from './parser';

export type RecurrenceEndMode = 'never' | 'count' | 'until';

export type RecurrenceFrequency =
  | 'daily'
  | 'weekly'
  | 'weekdays'
  | 'monthly'
  | 'quarterly'
  | 'yearly';

export interface ParsedRecurrenceRule {
  frequency: RecurrenceFrequency | null;
  endMode: RecurrenceEndMode;
  count: number | null;
  untilMs: number | null;
}

const RRULE_PREFIX = /^RRULE:/i;
const WEEKDAY_RULE = 'MO,TU,WE,TH,FR';

const EMPTY: ParsedRecurrenceRule = {
  frequency: null,
  endMode: 'never',
  count: null,
  untilMs: null,
};

export function normalizeRule(rule: string): string {
  return rule.replace(RRULE_PREFIX, '').trim();
}

function parseRuleParts(rule: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const part of normalizeRule(rule).split(';')) {
    const [rawKey, rawValue] = part.split('=', 2);
    if (!rawKey || !rawValue) continue;
    parsed[rawKey.toUpperCase()] = rawValue.toUpperCase();
  }
  return parsed;
}

function frequencyFromParts(
  parts: Record<string, string>
): RecurrenceFrequency | null {
  const { FREQ: freq, INTERVAL: interval, BYDAY: byDay } = parts;
  if (!freq) return null;
  if (!interval && !byDay) {
    if (freq === 'DAILY') return 'daily';
    if (freq === 'WEEKLY') return 'weekly';
    if (freq === 'MONTHLY') return 'monthly';
    if (freq === 'YEARLY') return 'yearly';
  }
  if (freq === 'WEEKLY' && !interval && byDay === WEEKDAY_RULE) {
    return 'weekdays';
  }
  if (freq === 'MONTHLY' && interval === '3' && !byDay) return 'quarterly';
  // Non-standard combinations still recur — map by FREQ so the grid can
  // expand them instead of silently dropping the event to one occurrence.
  if (freq === 'DAILY') return 'daily';
  if (freq === 'WEEKLY') return 'weekly';
  if (freq === 'MONTHLY') return 'monthly';
  if (freq === 'YEARLY') return 'yearly';
  return null;
}

function parsePositiveInt(value?: string): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : null;
}

/** Parse RRULE UNTIL forms: YYYYMMDDTHHMMSSZ, YYYYMMDDTHHMMSS, YYYYMMDD. */
function parseUntilMs(value: string): number | null {
  const clean = value.trim().toUpperCase();
  if (/^\d{8}(T\d{6}Z?)?$/.test(clean)) {
    const iso = clean.replace(/Z$/, '');
    const datePart = iso.slice(0, 8);
    const timePart = iso.slice(9, 15) || '000000';
    return Date.UTC(
      Number(datePart.slice(0, 4)),
      Number(datePart.slice(4, 6)) - 1,
      Number(datePart.slice(6, 8)),
      Number(timePart.slice(0, 2)),
      Number(timePart.slice(2, 4)),
      Number(timePart.slice(4, 6))
    );
  }
  return null;
}

function formatUntil(ms: number): string {
  return `${new Date(ms).toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

export function parseRecurrenceRule(
  rule: string | null | undefined
): ParsedRecurrenceRule {
  if (!rule) return EMPTY;
  const parts = parseRuleParts(rule);
  const frequency = frequencyFromParts(parts);
  if (!frequency) return EMPTY;

  const count = parsePositiveInt(parts.COUNT);
  if (count !== null) {
    return { frequency, endMode: 'count', count, untilMs: null };
  }
  const untilMs = parts.UNTIL ? parseUntilMs(parts.UNTIL) : null;
  if (untilMs !== null) {
    return { frequency, endMode: 'until', count: null, untilMs };
  }
  return { frequency, endMode: 'never', count: null, untilMs: null };
}

const FREQUENCY_TO_RRULE: Record<RecurrenceFrequency, string> = {
  daily: 'FREQ=DAILY',
  weekly: 'FREQ=WEEKLY',
  weekdays: `FREQ=WEEKLY;BYDAY=${WEEKDAY_RULE}`,
  monthly: 'FREQ=MONTHLY',
  quarterly: 'FREQ=MONTHLY;INTERVAL=3',
  yearly: 'FREQ=YEARLY',
};

/**
 * Build a bare RRULE string. `untilMs` is aligned to the event's start
 * time-of-day so the rule does not cut off the last occurrence (Form*
 * `alignUntilDateWithEventStart`).
 */
export function buildRecurrenceRule(options: {
  frequency: RecurrenceFrequency;
  endMode?: RecurrenceEndMode;
  count?: number | null;
  untilMs?: number | null;
  startMs: number;
}): string | null {
  const parts = [FREQUENCY_TO_RRULE[options.frequency]];
  const endMode = options.endMode ?? 'never';

  if (endMode === 'count') {
    const count = Math.max(1, options.count ?? 1);
    parts.push(`COUNT=${count}`);
  } else if (endMode === 'until' && options.untilMs) {
    const until = new Date(options.untilMs);
    const start = new Date(options.startMs);
    const aligned = new Date(
      until.getFullYear(),
      until.getMonth(),
      until.getDate(),
      start.getHours(),
      start.getMinutes(),
      start.getSeconds()
    ).getTime();
    parts.push(`UNTIL=${formatUntil(Math.max(aligned, options.startMs))}`);
  }
  return parts.join(';');
}

function rruleForEvent(event: CalendarEventData): RRule | null {
  if (!event.rrule) return null;
  const normalized = normalizeRule(event.rrule);
  if (!normalized) return null;
  try {
    return RRule.fromString(
      `DTSTART:${
        new Date(event.startMs).toISOString().replace(/[-:]/g, '').split('.')[0]
      }Z\nRRULE:${normalized}`
    );
  } catch {
    return null;
  }
}

/**
 * All occurrence START times (ms) of the event within
 * [rangeStartMs, rangeEndMs]. Non-recurring events yield [startMs] when the
 * event itself overlaps the range (start OR end inside, or spanning).
 */
export function getOccurrencesInRange(
  event: CalendarEventData,
  rangeStartMs: number,
  rangeEndMs: number
): number[] {
  if (!event.rrule) {
    const end = event.endMs ?? event.startMs;
    const overlaps =
      (event.startMs >= rangeStartMs && event.startMs <= rangeEndMs) ||
      (end >= rangeStartMs && end <= rangeEndMs) ||
      (event.startMs <= rangeStartMs && end >= rangeEndMs);
    return overlaps ? [event.startMs] : [];
  }

  const rule = rruleForEvent(event);
  if (!rule) return [];

  const duration = (event.endMs ?? event.startMs) - event.startMs;
  // An occurrence overlaps when its start <= rangeEnd and its end >=
  // rangeStart → occurrences can start as early as rangeStart - duration.
  const searchStart = new Date(
    Math.max(event.startMs, rangeStartMs - duration)
  );
  const searchEnd = new Date(rangeEndMs);
  return rule
    .between(searchStart, searchEnd, true)
    .map(occurrence => occurrence.getTime());
}

/** True when the event (or any occurrence) intersects the range. */
export function isEventInDateRange(
  event: CalendarEventData,
  rangeStartMs: number,
  rangeEndMs: number
): boolean {
  return getOccurrencesInRange(event, rangeStartMs, rangeEndMs).length > 0;
}

/** Human-readable summary of an RRULE string, e.g. "Every week on Monday". */
export function summarizeRecurrenceRule(rule: string): string {
  const normalized = normalizeRule(rule);
  if (!normalized) return rule;
  const parsed = parseRecurrenceRule(normalized);
  if (!parsed.frequency) return normalized;
  const labels: Record<RecurrenceFrequency, string> = {
    daily: 'Daily',
    weekly: 'Weekly',
    weekdays: 'Every weekday',
    monthly: 'Monthly',
    quarterly: 'Every 3 months',
    yearly: 'Yearly',
  };
  const endings =
    parsed.endMode === 'count'
      ? `, ${parsed.count}×`
      : parsed.endMode === 'until' && parsed.untilMs
        ? `, until ${new Date(parsed.untilMs).toLocaleDateString()}`
        : '';
  return `${labels[parsed.frequency]}${endings}`;
}
