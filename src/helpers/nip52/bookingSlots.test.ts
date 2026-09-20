/**
 * Tests for bookingSlots.ts — pure slot math for the calendar booking feature.
 *
 * tzOffsetMinutes uses the Date.getTimezoneOffset() convention (positive =
 * west of UTC), so all fixtures below work in fixed shifted-UTC space and are
 * independent of the machine's real timezone.
 */

import { describe, it, expect } from 'vitest';
import {
  computeBookingSlots,
  filterFreeSlots,
  isInVacation,
  occupiedRangesFromSlots,
  parseBookingConfig,
  BOOKING_SLOT_DTAG_PREFIX,
  type BookingConfig,
} from './bookingSlots';

const DAY = 86_400_000;

/** Owner in UTC+2 (tzOffsetMinutes = -120, getTimezoneOffset convention).
 * Owner-local Monday 2026-09-21 00:00 = real UTC Sun 2026-09-20 22:00. */
const OFFSET = -120;
const MON_LOCAL_MIDNIGHT = Date.UTC(2026, 8, 21, 0, 0) + OFFSET * 60_000;

function cfg(overrides: Partial<BookingConfig> = {}): BookingConfig {
  const day = (enabled: boolean) => ({
    enabled,
    startMinute: 9 * 60,
    endMinute: 12 * 60,
  });
  return {
    version: 1,
    enabled: true,
    title: '30 minute meeting',
    description: 'Intro call',
    slotMinutes: 30,
    bufferMinutes: 0,
    minLeadHours: 0,
    horizonDays: 7,
    tzOffsetMinutes: OFFSET,
    week: [
      day(false),
      day(true),
      day(true),
      day(true),
      day(true),
      day(true),
      day(false),
    ],
    vacations: [],
    ...overrides,
  };
}

describe('computeBookingSlots', () => {
  it('creates one slot per pitch across the daily window, correct times', () => {
    // Mon 09:00–12:00 owner-local, 30-min slots → 6 slots (09:00, 09:30 … 11:30).
    const slots = computeBookingSlots(cfg(), MON_LOCAL_MIDNIGHT - DAY);
    const mondaySlots = slots.filter(
      s =>
        s.startMs >= MON_LOCAL_MIDNIGHT && s.startMs < MON_LOCAL_MIDNIGHT + DAY
    );
    expect(mondaySlots).toHaveLength(6);
    expect(mondaySlots[0]!.startMs).toBe(MON_LOCAL_MIDNIGHT + 9 * 3_600_000);
    expect(mondaySlots[0]!.endMs).toBe(MON_LOCAL_MIDNIGHT + 9.5 * 3_600_000);
    expect(mondaySlots[5]!.startMs).toBe(MON_LOCAL_MIDNIGHT + 11.5 * 3_600_000);
  });

  it('respects disabled weekdays (config: Sun/Sat off)', () => {
    const slots = computeBookingSlots(cfg(), MON_LOCAL_MIDNIGHT);
    // Horizon 7 days from Mon → exactly Mon–Fri have slots, no weekend.
    const weekdays = new Set(
      slots.map(s => new Date(s.startMs + OFFSET * 60_000).getUTCDay())
    );
    expect(weekdays.has(0)).toBe(false);
    expect(weekdays.has(6)).toBe(false);
    expect(weekdays.size).toBe(5);
  });

  it('applies the buffer: 30-min slot + 30-min buffer → 3 slots in a 3h window', () => {
    const slots = computeBookingSlots(
      cfg({ bufferMinutes: 30 }),
      MON_LOCAL_MIDNIGHT - DAY
    );
    const mondaySlots = slots.filter(
      s =>
        s.startMs >= MON_LOCAL_MIDNIGHT && s.startMs < MON_LOCAL_MIDNIGHT + DAY
    );
    expect(mondaySlots).toHaveLength(3);
    expect(mondaySlots[1]!.startMs - mondaySlots[0]!.startMs).toBe(3_600_000);
  });

  it('skips slots earlier than minLeadHours from now', () => {
    // now = Monday 09:10 owner-local; lead 1h → 09:00, 09:30 and 10:00 must
    // not exist (10:00 starts only 50 minutes after now).
    const now = MON_LOCAL_MIDNIGHT + 9.1 * 3_600_000;
    const slots = computeBookingSlots(cfg({ minLeadHours: 1 }), now);
    expect(slots.some(s => s.startMs < now + 3_600_000)).toBe(false);
    expect(
      slots.some(s => s.startMs === MON_LOCAL_MIDNIGHT + 10.5 * 3_600_000)
    ).toBe(true);
  });

  it('skips vacation ranges', () => {
    const vacation = {
      startMs: MON_LOCAL_MIDNIGHT + DAY,
      endMs: MON_LOCAL_MIDNIGHT + 3 * DAY,
    };
    const slots = computeBookingSlots(
      cfg({ vacations: [vacation] }),
      MON_LOCAL_MIDNIGHT - DAY
    );
    const inVacation = slots.some(
      s => s.startMs >= vacation.startMs && s.startMs < vacation.endMs
    );
    expect(inVacation).toBe(false);
  });

  it('is deterministic: same config + now → identical d-tags', () => {
    const a = computeBookingSlots(cfg(), MON_LOCAL_MIDNIGHT - DAY);
    const b = computeBookingSlots(cfg(), MON_LOCAL_MIDNIGHT - DAY);
    expect(a.map(s => s.dTag)).toEqual(b.map(s => s.dTag));
    for (const slot of a) {
      expect(slot.dTag.startsWith(BOOKING_SLOT_DTAG_PREFIX)).toBe(true);
    }
  });
});

describe('filterFreeSlots', () => {
  const slots = computeBookingSlots(cfg(), MON_LOCAL_MIDNIGHT - DAY).filter(
    s => s.startMs >= MON_LOCAL_MIDNIGHT && s.startMs < MON_LOCAL_MIDNIGHT + DAY
  );

  it('removes only slots overlapping an occupied range', () => {
    const occupied = [
      { startMs: slots[1]!.startMs + 1, endMs: slots[2]!.endMs - 1 },
    ];
    const free = filterFreeSlots(slots, occupied);
    // slots[1] and slots[2] overlap; touching neighbors survive.
    expect(free.map(s => s.dTag)).toEqual([
      slots[0]!.dTag,
      slots[3]!.dTag,
      slots[4]!.dTag,
      slots[5]!.dTag,
    ]);
  });

  it('treats touching edges (end == next start) as free', () => {
    const occupied = [{ startMs: slots[0]!.startMs, endMs: slots[0]!.endMs }];
    const free = filterFreeSlots(slots, occupied);
    expect(free.map(s => s.dTag)).not.toContain(slots[0]!.dTag);
    expect(free.map(s => s.dTag)).toContain(slots[1]!.dTag);
  });

  it('is empty when every slot is occupied', () => {
    const occupied = slots.map(s => ({ startMs: s.startMs, endMs: s.endMs }));
    expect(filterFreeSlots(slots, occupied)).toEqual([]);
  });
});

describe('occupiedRangesFromSlots', () => {
  it('maps accepted d-tags to their ranges', () => {
    const slots = [
      { startMs: 1000, endMs: 2000, dTag: `${BOOKING_SLOT_DTAG_PREFIX}1` },
      { startMs: 3000, endMs: 4000, dTag: `${BOOKING_SLOT_DTAG_PREFIX}2` },
    ];
    const ranges = occupiedRangesFromSlots(slots, new Set([slots[1]!.dTag]));
    expect(ranges).toEqual([{ startMs: 3000, endMs: 4000 }]);
  });
});

describe('isInVacation', () => {
  it('half-open overlap: touching ranges do not count', () => {
    const v = [{ startMs: 2000, endMs: 3000 }];
    expect(isInVacation(v, 1000, 2000)).toBe(false);
    expect(isInVacation(v, 1000, 2001)).toBe(true);
    expect(isInVacation(v, 3000, 4000)).toBe(false);
  });
});

describe('parseBookingConfig', () => {
  it('round-trips a valid config and clamps insane values', () => {
    const base = cfg();
    const parsed = parseBookingConfig({
      ...base,
      slotMinutes: 999_999,
      horizonDays: 100_000,
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.slotMinutes).toBe(480);
    expect(parsed!.horizonDays).toBe(90);
    expect(parsed!.week).toHaveLength(7);
  });

  it('rejects garbage and malformed week arrays', () => {
    expect(parseBookingConfig(null)).toBeNull();
    expect(parseBookingConfig('nope')).toBeNull();
    expect(parseBookingConfig({ week: [], vacations: [] })).toBeNull();
  });

  it('drops vacation ranges with inverted bounds', () => {
    const parsed = parseBookingConfig({
      ...cfg(),
      vacations: [
        { startMs: 3000, endMs: 2000 },
        { startMs: 1000, endMs: 2000 },
      ],
    });
    expect(parsed!.vacations).toEqual([{ startMs: 1000, endMs: 2000 }]);
  });

  it('clamps a day window whose end is before its start (no negative period)', () => {
    // UI regression guard: 19:00–18:00 entered by hand must clamp end to start.
    const base = cfg();
    base.week[1] = { enabled: true, startMinute: 1140, endMinute: 1080 };
    const parsed = parseBookingConfig({ ...base });
    expect(parsed!.week[1]).toEqual({
      enabled: true,
      startMinute: 1140,
      endMinute: 1140,
    });
    // An empty window produces no slots on that day (other days unaffected).
    // week[1] = Monday (getDay convention, 0 = Sunday).
    const slots = computeBookingSlots(parsed!, MON_LOCAL_MIDNIGHT);
    const mondaySlots = slots.filter(
      s =>
        s.startMs >= MON_LOCAL_MIDNIGHT && s.startMs < MON_LOCAL_MIDNIGHT + DAY
    );
    expect(mondaySlots).toEqual([]);
  });
});
