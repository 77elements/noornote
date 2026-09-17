/**
 * NIP-52 calendar event parsing/serialization (kinds 31922 / 31923 / 31924).
 *
 * Reference: formstr-hq/nostr-calendar `src/utils/parser.ts` + NIP-52 spec.
 * Pure functions only — no transport, no DOM (unit-testable).
 *
 * Kind 31923 (time-based): `start`/`end` are unix SECONDS.
 * Kind 31922 (date-based): `start`/`end` are ISO dates (YYYY-MM-DD), parsed
 * as UTC midnight so all-day semantics are timezone-stable.
 * Recurring events carry NIP-52R labels: `["L", "rrule"] ["l", "<RRULE>"]`.
 */

export const CALENDAR_EVENT_TIME_KIND = 31923;
export const CALENDAR_EVENT_DATE_KIND = 31922;
export const CALENDAR_COLLECTION_KIND = 31924;

/**
 * Private (NIP-52E, Form*-style) calendar events — encrypted payload in
 * `content`, only `["d", …]` is visible on the wire. Kind 32679 is the
 * recurring variant. Payload tags use the 31923 (unix seconds) format.
 */
export const PRIVATE_EVENT_KIND = 32678;
export const PRIVATE_RECURRING_EVENT_KIND = 32679;
/** Private calendar list — NIP-44 self-encrypted kind 32123. */
export const PRIVATE_LIST_KIND = 32123;

export interface CalendarEventData {
  /** `<kind>:<pubkey>:<dTag>` — addressable coordinate (NIP-01 §16). */
  coordinate: string;
  eventId: string;
  kind: number;
  pubkey: string;
  dTag: string;
  title: string;
  /** Event `.content` — the NIP-52 description. */
  description: string;
  /** Milliseconds since epoch (UTC midnight for kind 31922). */
  startMs: number;
  /** Milliseconds since epoch, or null when the event has no end. */
  endMs: number | null;
  /** True for kind 31922 (all-day). */
  allDay: boolean;
  /** Optional cover image URL. */
  image?: string | undefined;
  locations: string[];
  geoHashes: string[];
  /** Participant pubkeys from `p` tags. */
  participants: string[];
  hashtags: string[];
  links: string[];
  /** NIP-52R RRULE string (bare, no `RRULE:` prefix), or null. */
  rrule: string | null;
  createdAt: number;
  /** True for NIP-52E private events (kind 32678/32679). */
  isPrivate?: boolean | undefined;
  /** Private events: hex view-key secret for decryption/re-publish. */
  viewSecretHex?: string | undefined;
  /** Private events: d-tag of the owning private calendar list (kind 32123). */
  listId?: string | undefined;
}

export interface CalendarCollectionData {
  coordinate: string;
  eventId: string;
  pubkey: string;
  dTag: string;
  title: string;
  /** Collection `.content` — free-text description. */
  description: string;
  /** Referenced calendar events as `kind:pubkey:dTag` coordinates. */
  eventRefs: string[];
  createdAt: number;
}

/**
 * Loose input shape so NDK `NostrEvent` (optional props) passes as-is.
 */
export interface CalendarEventRawInput {
  id?: string | undefined;
  kind?: number | undefined;
  pubkey: string;
  created_at?: number | undefined;
  content?: string | undefined;
  tags?: string[][] | undefined;
}

function getTagValues(tags: string[][], key: string): string[] {
  return tags.flatMap(tag => (tag[0] === key && tag[1] ? [tag[1]] : []));
}

function getTagValue(tags: string[][], key: string): string | undefined {
  return tags.find(tag => tag[0] === key && tag[1])?.[1];
}

export function buildCalendarCoordinate(
  kind: number,
  pubkey: string,
  dTag: string
): string {
  return `${kind}:${pubkey}:${dTag}`;
}

/** Parse an ISO date (YYYY-MM-DD) as UTC midnight, or NaN when invalid. */
function parseIsoDateMs(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  return Date.UTC(
    Number(value.slice(0, 4)),
    Number(value.slice(5, 7)) - 1,
    Number(value.slice(8, 10))
  );
}

/**
 * Parse a kind 31922/31923 event — or an encrypted private event's decrypted
 * payload as kind 32678/32679 — into CalendarEventData. Returns null when
 * the event is malformed (no d-tag or no valid start).
 */
export function parseCalendarEvent(
  event: CalendarEventRawInput
): CalendarEventData | null {
  if (
    event.kind !== CALENDAR_EVENT_TIME_KIND &&
    event.kind !== CALENDAR_EVENT_DATE_KIND &&
    event.kind !== PRIVATE_EVENT_KIND &&
    event.kind !== PRIVATE_RECURRING_EVENT_KIND
  ) {
    return null;
  }
  const isPrivate =
    event.kind === PRIVATE_EVENT_KIND ||
    event.kind === PRIVATE_RECURRING_EVENT_KIND;
  const dTag = getTagValue(event.tags ?? [], 'd');
  if (!dTag) return null;
  const tags = event.tags ?? [];

  const rawStart = getTagValue(tags, 'start');
  if (!rawStart) return null;

  let startMs: number;
  if (event.kind === CALENDAR_EVENT_DATE_KIND) {
    startMs = parseIsoDateMs(rawStart);
  } else {
    const seconds = Number(rawStart);
    startMs = Number.isFinite(seconds) ? seconds * 1000 : NaN;
  }
  if (!Number.isFinite(startMs)) return null;

  let endMs: number | null = null;
  const rawEnd = getTagValue(tags, 'end');
  if (rawEnd) {
    if (event.kind === CALENDAR_EVENT_DATE_KIND) {
      // NIP-52: exclusive end date. Keep it as-is (day semantics).
      const parsed = parseIsoDateMs(rawEnd);
      endMs = Number.isFinite(parsed) ? parsed : null;
    } else {
      const seconds = Number(rawEnd);
      endMs = Number.isFinite(seconds) ? seconds * 1000 : null;
    }
    if (endMs !== null && endMs <= startMs) endMs = null;
  }

  // NIP-52R: `["L", "rrule"]` declares the namespace, the NEXT tag
  // `["l", "<rule>"]` carries the rule (Form* two-tag form). Also accept the
  // full NIP-32 form `["l", "<rule>", "rrule"]`.
  let rrule: string | null = null;
  for (let i = 0; i < tags.length; i++) {
    const decl = tags[i];
    if (!decl || decl[0] !== 'L' || decl[1] !== 'rrule') continue;
    const candidate = tags[i + 1];
    if (candidate && candidate[0] === 'l' && candidate[1]) {
      rrule = candidate[1];
    }
    break;
  }

  const participants = getTagValues(tags, 'p');

  return {
    coordinate: buildCalendarCoordinate(event.kind, event.pubkey, dTag),
    eventId: event.id ?? '',
    kind: event.kind,
    pubkey: event.pubkey,
    dTag,
    title: getTagValue(tags, 'title') ?? getTagValue(tags, 'name') ?? '',
    // Public events carry the description in `.content`; private payloads in
    // an encrypted `description` tag (their `.content` is the ciphertext).
    description:
      getTagValue(tags, 'description') ??
      (isPrivate ? '' : event.content || ''),
    startMs,
    endMs,
    allDay: event.kind === CALENDAR_EVENT_DATE_KIND,
    image: getTagValue(tags, 'image'),
    locations: getTagValues(tags, 'location'),
    geoHashes: getTagValues(tags, 'g'),
    participants,
    hashtags: getTagValues(tags, 't'),
    links: getTagValues(tags, 'r'),
    rrule,
    createdAt: event.created_at ?? 0,
    isPrivate: isPrivate || undefined,
  };
}

/** Parse a kind 31924 calendar collection. Returns null when malformed. */
export function parseCalendarCollection(
  event: CalendarEventRawInput
): CalendarCollectionData | null {
  if (event.kind !== CALENDAR_COLLECTION_KIND) return null;
  const dTag = getTagValue(event.tags ?? [], 'd');
  if (!dTag) return null;

  return {
    coordinate: buildCalendarCoordinate(event.kind, event.pubkey, dTag),
    eventId: event.id ?? '',
    pubkey: event.pubkey,
    dTag,
    title: getTagValue(event.tags ?? [], 'title') ?? '',
    description: event.content || '',
    eventRefs: getTagValues(event.tags ?? [], 'a'),
    createdAt: event.created_at ?? 0,
  };
}

/**
 * Serialize a CalendarEventData into NIP-52 tags (for publishing, phase 2).
 * Kind 31923 uses unix seconds; kind 31922 uses ISO dates. `end` is omitted
 * when null. `D` day tags (NIP-52, kind 31923) are intentionally not emitted
 * for v1 — clients must not rely on them for discovery anyway (NIP-52R).
 */
export function calendarEventToTags(event: CalendarEventData): string[][] {
  const tags: string[][] = [['d', event.dTag]];
  if (event.title) tags.push(['title', event.title]);

  if (event.allDay) {
    tags.push(['start', toIsoDate(event.startMs)]);
    if (event.endMs !== null) tags.push(['end', toIsoDate(event.endMs)]);
  } else {
    tags.push(['start', String(Math.floor(event.startMs / 1000))]);
    if (event.endMs !== null) {
      tags.push(['end', String(Math.floor(event.endMs / 1000))]);
    }
  }

  if (event.image) tags.push(['image', event.image]);
  for (const loc of event.locations) tags.push(['location', loc]);
  for (const geo of event.geoHashes) tags.push(['g', geo]);
  for (const tag of event.hashtags) tags.push(['t', tag]);
  for (const link of event.links) tags.push(['r', link]);
  for (const participant of event.participants) tags.push(['p', participant]);

  if (event.rrule) {
    tags.push(['L', 'rrule']);
    tags.push(['l', event.rrule]);
  }
  return tags;
}

/** Milliseconds since epoch → YYYY-MM-DD (UTC). */
export function toIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
