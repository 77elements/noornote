/**
 * ICS import — pure logic for the Personal calendar import (serverless):
 * parse an .ics file (RFC 5545) into import candidates, filter by a
 * visitor-selected time range and map them to calendar event drafts.
 *
 * Scope (v1): VEVENTs only (VTODO/VTIMEZONE/VALARM skipped), STATUS:CANCELLED
 * skipped, RRULE series imported as series (range filter checks whether at
 * least one occurrence falls into the range), RECURRENCE-ID exceptions
 * simplified away (whole series wins).
 */

import type { CalendarEventData } from './parser';
import {
  getOccurrencesInRange,
  parseRecurrenceRule,
  type ParsedRecurrenceRule,
} from './recurrence';

export const BOOKING_SLOT_PREFIX = 'bookslot-';

export interface ICSImportCandidate {
  dTag: string;
  title: string;
  description: string;
  location: string;
  startMs: number;
  endMs: number | null;
  allDay: boolean;
  /** Normalized bare RRULE (without `RRULE:` prefix), or null. */
  rrule: string | null;
  recurrence: ParsedRecurrenceRule;
}

export interface ICSImportPreview {
  /** Candidates inside the (optional) time range — publish-ready. */
  candidates: ICSImportCandidate[];
  /** Single events skipped because they fall outside the range. */
  outOfRange: number;
  /** VEVENTs that could not be parsed. */
  failed: number;
  /** VEVENTs skipped because STATUS:CANCELLED. */
  cancelled: number;
}

/** Unfold RFC 5545 line folding (CRLF/space continuation). */
function unfoldICS(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n');
}

/** Split `NAME;PARAM=VALUE;PARAM2:content` into name, params and value. */
function parseContentLine(line: string): {
  name: string;
  params: Record<string, string>;
  value: string;
} {
  const colon = line.indexOf(':');
  if (colon === -1) return { name: '', params: {}, value: '' };
  const value = line.slice(colon + 1);
  const head = line.slice(0, colon);
  const [name = '', ...paramParts] = head.split(';');
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    params[part.slice(0, eq).toUpperCase()] = part
      .slice(eq + 1)
      .replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value };
}

/** Unescape RFC 5545 text (DESCRIPTION/SUMMARY/LOCATION). */
function icsUnescape(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/**
 * Convert a zoned/floating/UTC iCal date-time value to UTC ms.
 * `TZID` is an IANA name — DST-safe via Intl offset lookup (iterative).
 */
function icsDateValueToUtcMs(
  value: string,
  params: Record<string, string>,
  fallbackTimeZone: string
): { ms: number; allDay: boolean } | null {
  const valueClean = value.trim();
  // All-day: YYYYMMDD (VALUE=DATE) → UTC midnight.
  if (/^\d{8}$/.test(valueClean)) {
    const ms = Date.parse(
      `${valueClean.slice(0, 4)}-${valueClean.slice(4, 6)}-${valueClean.slice(6, 8)}T00:00:00Z`
    );
    return Number.isFinite(ms) ? { ms, allDay: true } : null;
  }

  const match = valueClean.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/
  );
  if (!match) return null;
  const [, y = '', mo = '', d = '', h = '', mi = '', s = '', z] = match;
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  if (z) return { ms: wall, allDay: false }; // UTC

  const timeZone = params.TZID || fallbackTimeZone;
  // Iterate: wall clock in `timeZone` → real UTC (DST-safe after ≤3 passes).
  let utc = wall;
  for (let i = 0; i < 3; i++) {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = dtf.formatToParts(new Date(utc));
    const get = (type: string) =>
      Number(parts.find(p => p.type === type)?.value ?? 0);
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24,
      get('minute'),
      get('second')
    );
    const next = wall - (asUtc - Math.floor(utc / 1000) * 1000);
    if (next === utc) break;
    utc = next;
  }
  return { ms: utc, allDay: false };
}

const RANDOM_DTAG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Deterministic d-tag for an imported event: same event in the same (or
 * another) .ics file always maps to the same coordinate, so re-imports are
 * idempotent instead of stacking duplicate drafts. Prefers the VEVENT UID
 * (its reason to exist), falls back to a content hash. Hash-only output
 * keeps the d-tag colon-free — safe inside `kind:pubkey:dtag` coordinates.
 */
export function deriveImportDTag(
  uid: string,
  title: string,
  startMs: number,
  allDay: boolean
): string {
  let hash = 0x811c9dc5;
  const feed = (input: string): void => {
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  };
  feed(uid || `${title}\u0000${startMs}\u0000${allDay ? '1' : '0'}`);
  let out = '';
  while (out.length < 16) {
    hash = Math.imul(hash ^ (hash >>> 15), 0x2545f491) >>> 0;
    out += RANDOM_DTAG_ALPHABET[hash % RANDOM_DTAG_ALPHABET.length];
  }
  return `ics-${out}`;
}

/** Parse an .ics file body into import candidates (cancelled/invalid skipped). */
export function parseICSCalendar(
  text: string,
  fallbackTimeZone: string
): ICSImportPreview {
  const lines = unfoldICS(text);
  const candidates: ICSImportCandidate[] = [];
  let failed = 0;
  let cancelled = 0;

  let inEvent = false;
  let cancelledEvent = false;
  let current: Record<string, string> = {};
  /** Parsed property line: value + params, keyed by property name. */
  let currentLines: Record<
    string,
    { value: string; params: Record<string, string> }
  > = {};
  let currentRRULE = '';

  const flush = (): void => {
    if (!inEvent) return;
    inEvent = false;
    if (cancelledEvent) {
      cancelled++;
      return;
    }
    const start = currentLines.DTSTART;
    if (!start) {
      failed++;
      return;
    }
    const startMsParsed = icsDateValueToUtcMs(
      start.value,
      start.params,
      fallbackTimeZone
    );
    if (!startMsParsed) {
      failed++;
      return;
    }
    let end: number | null = null;
    const allDay = startMsParsed.allDay;
    const endLine = currentLines.DTEND;
    if (endLine) {
      const parsedEnd = icsDateValueToUtcMs(
        endLine.value,
        endLine.params,
        fallbackTimeZone
      );
      if (parsedEnd && parsedEnd.ms > startMsParsed.ms) end = parsedEnd.ms;
    }
    if (end === null && !allDay) {
      // Google often omits DTEND for zero-length timed events.
      end = startMsParsed.ms;
    }

    const recurrence = parseRecurrenceRule(currentRRULE || null);
    const title = icsUnescape(current.SUMMARY ?? '');
    candidates.push({
      dTag: deriveImportDTag(
        current.UID ?? '',
        title,
        startMsParsed.ms,
        allDay
      ),
      title,
      description: icsUnescape(current.DESCRIPTION ?? ''),
      location: icsUnescape(current.LOCATION ?? ''),
      startMs: startMsParsed.ms,
      endMs: end,
      allDay,
      rrule: recurrence.frequency ? currentRRULE || null : null,
      recurrence,
    });
  };

  for (const rawLine of lines) {
    const { name, params, value } = parseContentLine(rawLine);
    if (name === 'BEGIN' && value.toUpperCase() === 'VEVENT') {
      inEvent = true;
      cancelledEvent = false;
      current = {};
      currentLines = {};
      currentRRULE = '';
      continue;
    }
    if (name === 'END' && value.toUpperCase() === 'VEVENT') {
      flush();
      continue;
    }
    if (!inEvent) continue;

    if (name === 'STATUS' && value.toUpperCase() === 'CANCELLED') {
      cancelledEvent = true;
      continue;
    }
    if (name === 'RRULE') {
      currentRRULE = value;
      continue;
    }
    if (name === 'RECURRENCE-ID') {
      // Series exception — v1 imports the series as a whole (simplified).
      cancelledEvent = true;
      continue;
    }
    if (currentLines[name]) continue;
    currentLines[name] = { value, params };
    current[name] = icsUnescape(value);
  }

  return {
    candidates,
    outOfRange: 0,
    failed,
    cancelled,
  };
}

/**
 * Time-range filter: keep single events inside the range and series with at
 * least one occurrence in the range. Empty bounds = unbounded on that side.
 */
export function filterCandidatesByRange(
  candidates: ICSImportCandidate[],
  rangeStartMs: number | null,
  rangeEndMs: number | null
): { inRange: ICSImportCandidate[]; outOfRange: number } {
  if (rangeStartMs === null && rangeEndMs === null) {
    return { inRange: candidates, outOfRange: 0 };
  }
  const start = rangeStartMs ?? Number.NEGATIVE_INFINITY;
  const end = rangeEndMs ?? Number.POSITIVE_INFINITY;
  const inRange: ICSImportCandidate[] = [];
  let outOfRange = 0;
  for (const candidate of candidates) {
    const shim: CalendarEventData = {
      coordinate: `ics:${candidate.dTag}`,
      eventId: '',
      kind: 31923,
      pubkey: '',
      dTag: candidate.dTag,
      title: candidate.title,
      description: candidate.description,
      startMs: candidate.startMs,
      endMs: candidate.endMs,
      allDay: candidate.allDay,
      locations: [],
      geoHashes: [],
      participants: [],
      hashtags: [],
      links: [],
      rrule: candidate.rrule,
      createdAt: 0,
    };
    const occurrences = getOccurrencesInRange(shim, start, end);
    const hits = occurrences.some(o => o >= start && o <= end);
    if (hits) {
      inRange.push(candidate);
    } else {
      outOfRange++;
    }
  }
  return { inRange, outOfRange };
}

/** Map an import candidate to the publishable draft fields. */
export function candidateToDraftFields(candidate: ICSImportCandidate): {
  title: string;
  description: string;
  startMs: number;
  endMs: number | null;
  allDay: boolean;
  repeat: import('./recurrence').RecurrenceFrequency | null;
  rruleOverride: string | null;
  location: string;
} {
  return {
    title: candidate.title,
    description: candidate.description,
    startMs: candidate.startMs,
    endMs: candidate.endMs,
    allDay: candidate.allDay,
    repeat: candidate.recurrence.frequency,
    rruleOverride: candidate.rrule,
    location: candidate.location,
  };
}
