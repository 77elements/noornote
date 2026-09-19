/**
 * Booking slot computation — pure logic for the calendar booking feature
 * (Calendly-style availability on top of NIP-52).
 *
 * Model (mirrors cal.emre.xyz, nostr-native):
 *   - The owner defines weekly availability rules + vacation ranges in a
 *     BookingConfig (published as a NIP-78 kind-30078 event, d=noornote-booking).
 *   - Slots are MATERIALIZED as real kind-31923 calendar events (d-tag
 *     `bookslot-<startSeconds>`, deterministic so a config change diffs into
 *     publish/delete instead of duplicates). Guests book by publishing an
 *     accepted kind-31925 RSVP on the slot; a slot with an accepted RSVP is
 *     occupied.
 *
 * All math is UTC-shifted by the owner's timezone offset so slot times are
 * stable in the OWNER's local wall clock, independent of who views them.
 */

/** Owner-local availability for one weekday. Minutes from local midnight. */
export interface BookingDayRule {
  enabled: boolean;
  /** Minutes from local midnight, e.g. 540 = 09:00. */
  startMinute: number;
  endMinute: number;
}

export interface BookingVacationRange {
  startMs: number;
  endMs: number;
}

export interface BookingConfig {
  version: 1;
  enabled: boolean;
  /** Slot headline, e.g. "30 minute meeting". */
  title: string;
  /** Shown on the booking page and used as slot event description. */
  description: string;
  /** Slot length in minutes (15–480). */
  slotMinutes: number;
  /** Gap after each slot in minutes (0–240). */
  bufferMinutes: number;
  /** Earliest bookable start, in hours from now (0–336). */
  minLeadHours: number;
  /** How far ahead slots are materialized, in days (1–90). */
  horizonDays: number;
  /**
   * Owner-local UTC offset in minutes captured at generation time, using the
   * `Date.getTimezoneOffset()` convention (positive = west of UTC).
   */
  tzOffsetMinutes: number;
  /** 7 entries, index = owner-local weekday, 0 = Sunday (Date.getDay convention). */
  week: BookingDayRule[];
  vacations: BookingVacationRange[];
}

export interface ComputedSlot {
  startMs: number;
  endMs: number;
  /** Deterministic: same slot time → same d-tag → replaceable, diff-friendly. */
  dTag: string;
}

export interface OccupiedRange {
  startMs: number;
  endMs: number;
}

export const BOOKING_SLOT_DTAG_PREFIX = 'bookslot-';
export const BOOKING_HASHTAG = 'booking';
/** d-tag of the NIP-78 (kind 30078) booking config event. */
export const BOOKING_CONFIG_DTAG = 'noornote-booking';
export const BOOKING_CONFIG_KIND = 30078;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** Clamps + defaults; returns null when the payload is not a usable config. */
export function parseBookingConfig(raw: unknown): BookingConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Record<string, unknown>;
  const num = (v: unknown, min: number, max: number, fallback: number) => {
    const n =
      typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
    return Math.min(max, Math.max(min, n));
  };
  if (
    !Array.isArray(c.week) ||
    c.week.length !== 7 ||
    !Array.isArray(c.vacations)
  ) {
    return null;
  }
  const week: BookingDayRule[] = [];
  for (const day of c.week) {
    const d = (day ?? {}) as Record<string, unknown>;
    const enabled = d.enabled === true;
    const startMinute = num(d.startMinute, 0, 1439, 540);
    const endMinute = num(d.endMinute, 0, 1440, 1080);
    week.push({
      enabled,
      startMinute,
      endMinute: Math.max(endMinute, startMinute),
    });
  }
  const vacations: BookingVacationRange[] = [];
  for (const v of c.vacations) {
    const r = (v ?? {}) as Record<string, unknown>;
    if (typeof r.startMs === 'number' && typeof r.endMs === 'number') {
      if (r.endMs > r.startMs) {
        vacations.push({ startMs: r.startMs, endMs: r.endMs });
      }
    }
  }
  const title = typeof c.title === 'string' ? c.title.slice(0, 120) : '';
  const description =
    typeof c.description === 'string' ? c.description.slice(0, 1000) : '';
  return {
    version: 1,
    enabled: c.enabled === true,
    title,
    description,
    slotMinutes: num(c.slotMinutes, 5, 480, 30),
    bufferMinutes: num(c.bufferMinutes, 0, 240, 0),
    minLeadHours: num(c.minLeadHours, 0, 336, 4),
    horizonDays: num(c.horizonDays, 1, 90, 56),
    tzOffsetMinutes: num(c.tzOffsetMinutes, -840, 840, 0),
    week,
    vacations,
  };
}

/**
 * Materialize bookable slots from the weekly rules.
 *
 * Deterministic: the same config + `nowMs` always yields the same slot set,
 * keyed by `bookslot-<startSeconds>` d-tags, so the publisher can diff
 * desired vs. existing events into publish/delete operations.
 */
export function computeBookingSlots(
  config: BookingConfig,
  nowMs: number
): ComputedSlot[] {
  const off = config.tzOffsetMinutes * MINUTE_MS;
  const pitchMs = (config.slotMinutes + config.bufferMinutes) * MINUTE_MS;
  const lengthMs = config.slotMinutes * MINUTE_MS;
  const earliestStart = nowMs + config.minLeadHours * 3_600_000;
  const horizonEnd = nowMs + config.horizonDays * DAY_MS;

  const slots: ComputedSlot[] = [];
  // Owner-local day number: shift by the offset, work in UTC, shift back.
  const firstDay = Math.floor((nowMs + off) / DAY_MS);
  const lastDay = Math.floor((horizonEnd + off) / DAY_MS);

  for (let day = firstDay; day <= lastDay; day++) {
    const localDayStartMs = day * DAY_MS - off;
    const weekday = new Date(day * DAY_MS).getUTCDay();
    const rule = config.week[weekday];
    if (!rule || !rule.enabled) continue;

    const windowStart = localDayStartMs + rule.startMinute * MINUTE_MS;
    const windowEnd = localDayStartMs + rule.endMinute * MINUTE_MS;

    for (
      let startMs = windowStart;
      startMs + lengthMs <= windowEnd;
      startMs += pitchMs
    ) {
      const endMs = startMs + lengthMs;
      if (startMs < earliestStart) continue;
      if (isInVacation(config.vacations, startMs, endMs)) continue;
      slots.push({
        startMs,
        endMs,
        dTag: `${BOOKING_SLOT_DTAG_PREFIX}${Math.floor(startMs / 1000)}`,
      });
    }
  }

  return slots.sort((a, b) => a.startMs - b.startMs);
}

/** True when [startMs, endMs) overlaps any vacation range. */
export function isInVacation(
  vacations: BookingVacationRange[],
  startMs: number,
  endMs: number
): boolean {
  return vacations.some(v => startMs < v.endMs && endMs > v.startMs);
}

/**
 * Keep only slots that do not overlap any occupied range (accepted RSVPs).
 * Overlap test is half-open: [start, end) — touching edges do not collide.
 */
export function filterFreeSlots(
  slots: ComputedSlot[],
  occupied: OccupiedRange[]
): ComputedSlot[] {
  return slots.filter(
    slot =>
      !occupied.some(o => slot.startMs < o.endMs && slot.endMs > o.startMs)
  );
}

/** Occupied ranges for slots that already have an accepted RSVP. */
export function occupiedRangesFromSlots(
  slots: ComputedSlot[],
  acceptedDTags: Set<string>
): OccupiedRange[] {
  return slots
    .filter(s => acceptedDTags.has(s.dTag))
    .map(s => ({ startMs: s.startMs, endMs: s.endMs }));
}
