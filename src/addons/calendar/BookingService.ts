/**
 * BookingService — Calendly-style appointment booking on top of NIP-52.
 *
 * Nostr-native, no backend (model mirrors cal.emre.xyz):
 *   - Config (weekly rules, slot length, lead time, horizon, vacations)
 *     publishes as a public NIP-78 kind-30078 event (d=noornote-booking).
 *   - Slots materialize as real kind-31923 calendar events with d-tag
 *     `bookslot-<startSeconds>` and a `t=booking` marker. Deterministic
 *     d-tags let a config change diff into publish/delete operations.
 *   - A guest books by publishing an accepted kind-31925 RSVP on the slot —
 *     a slot with an accepted RSVP is occupied (double-booking protection).
 *   - The guest additionally sends the owner a NIP-17 DM with the booking
 *     summary (guest name/note live ONLY in the DM, never in public events).
 *
 * Publish rules (AGENTS.md): sign via AuthService.signEvent(), publish via
 * NostrTransport, deletions via CalendarPublishService (calendar relay set +
 * DeletionService breadth).
 */

import type { NostrEvent, NDKKind } from '@nostr-dev-kit/ndk';
import { AuthService } from '../../services/AuthService';
import { NostrTransport } from '../../services/transport/NostrTransport';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { DMsModuleApi } from '../../modules/dms/contracts';
import { diagLog } from '../../services/DiagnosticLogger';
import { encodeNpub } from '../../services/NostrToolsAdapter';
import { resolveCalendarRelays } from './relays';
import { UserProfileService } from '../../services/UserProfileService';
import { ReminderHub } from '../../services/notifications/ReminderHub';
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../services/PerAccountLocalStorage';
import {
  parseCalendarEvent,
  type CalendarEventData,
} from '../../helpers/nip52/parser';
import { dedupeByCoordinateWithTombstones } from '../../helpers/addressableDedupe';
import {
  computeBookingSlots,
  parseBookingConfig,
  BOOKING_CONFIG_DTAG,
  BOOKING_CONFIG_KIND,
  BOOKING_HASHTAG,
  BOOKING_SLOT_DTAG_PREFIX,
  type BookingConfig,
} from '../../helpers/nip52/bookingSlots';
import {
  CalendarPublishService,
  type CalendarEventDraft,
} from './CalendarPublishService';

const FETCH_TIMEOUT_MS = 8000;
/** Kind 31922/31923 coordinate prefixes for the tombstone filter. */
const COORD_PREFIXES = ['31922:', '31923:'];

// ReminderHub namespaces (ID ranges — see ReminderHub.ts range table).
const REMINDER_NAMESPACE_OWNER = 'booking-owner';
const REMINDER_ID_BASE_OWNER = 90_004_000;
const REMINDER_POOL_SIZE_OWNER = 32;
const REMINDER_NAMESPACE_GUEST = 'booking-guest';
const REMINDER_ID_BASE_GUEST = 90_005_000;
const REMINDER_POOL_SIZE_GUEST = 32;

/** A booking the current account made on someone's booking page (guest side). */
export interface MyBookingRecord {
  ownerPubkey: string;
  dTag: string;
  title: string;
  startMs: number;
  endMs: number;
  /** Guest name + note from the booking form — reused in cancellation DMs. */
  guestName: string;
  note: string;
  /** Additional participants (hex pubkeys) — for cancellation DMs. */
  participants: string[];
}

/** Structured outcome of a booking operation — every path ends here. */
export interface BookingOpResult {
  /** True when the relay publish was confirmed (≥1 relay accepted). */
  ok: boolean;
  /** Human-readable outcome for the final toast. */
  detail: string;
  /** Recipients successfully DM'd. */
  informed: number;
  /** DM attempts that failed. */
  dmFailures: number;
}

export interface OwnerSlot {
  /** Parsed slot event. */
  data: CalendarEventData;
  /** Accepted-RSVP responder pubkey, or null when the slot is free. */
  bookedBy: string | null;
  /** True when the current account made this booking. */
  bookedByMe: boolean;
  /** Additional participants (p-tags on the accepted RSVP). */
  participants: string[];
}

export interface RebuildResult {
  published: number;
  deleted: number;
}

export class BookingService {
  private static instance: BookingService | null = null;
  private hub = ReminderHub.getInstance();

  constructor() {
    this.registerReminderNamespaces();
  }

  public static getInstance(): BookingService {
    if (!BookingService.instance) {
      BookingService.instance = new BookingService();
    }
    return BookingService.instance;
  }

  /**
   * Register the booking reminder pools. Both builders fetch fresh state at
   * reschedule time — the owner side reads the relay slot list, the guest
   * side the per-account local booking records.
   */
  private registerReminderNamespaces(): void {
    const hub = this.hub;
    hub.registerNamespace({
      name: REMINDER_NAMESPACE_OWNER,
      idBase: REMINDER_ID_BASE_OWNER,
      poolSize: REMINDER_POOL_SIZE_OWNER,
      build: async () => {
        const pubkey = this.auth.getCurrentUser()?.pubkey ?? '';
        if (!pubkey) return [];
        const slots = await this.fetchOwnerSlots(pubkey);
        return slots
          .filter(s => s.bookedBy)
          .map((s, index) => ({
            id: REMINDER_ID_BASE_OWNER + index,
            title: s.data.title || 'Appointment',
            body: `Your booked meeting starts now — guest: ${
              UserProfileService.getInstance().getUsername(s.bookedBy!) ||
              'guest'
            }`,
            fireAt: s.data.startMs,
            allowWhileIdle: true,
          }));
      },
    });
    hub.registerNamespace({
      name: REMINDER_NAMESPACE_GUEST,
      idBase: REMINDER_ID_BASE_GUEST,
      poolSize: REMINDER_POOL_SIZE_GUEST,
      build: async () => {
        const now = Date.now();
        const records = this.getMyBookings().filter(r => r.startMs > now);
        return records.map((r, index) => ({
          id: REMINDER_ID_BASE_GUEST + index,
          title: r.title || 'Appointment',
          body: 'Your booked meeting starts now.',
          fireAt: r.startMs,
          allowWhileIdle: true,
        }));
      },
    });
  }

  // ========== Guest-side booking records (reminders) ==========

  private getMyBookings(): MyBookingRecord[] {
    try {
      return PerAccountLocalStorage.getInstance().get<MyBookingRecord[]>(
        StorageKeys.BOOKING_MY_BOOKINGS,
        []
      );
    } catch {
      return [];
    }
  }

  private saveMyBookingRecord(record: MyBookingRecord): void {
    try {
      const records = this.getMyBookings().filter(r => r.dTag !== record.dTag);
      const now = Date.now();
      // Prune past bookings — they only exist for the reminder.
      const alive = records.filter(r => r.endMs > now);
      alive.push(record);
      PerAccountLocalStorage.getInstance().set(
        StorageKeys.BOOKING_MY_BOOKINGS,
        alive
      );
    } catch (err) {
      diagLog('system', 'booking: record save failed', { error: String(err) });
    }
  }

  /** Drop one guest booking record (after cancellation). */
  private removeMyBookingRecord(dTag: string): void {
    try {
      const alive = this.getMyBookings().filter(r => r.dTag !== dTag);
      PerAccountLocalStorage.getInstance().set(
        StorageKeys.BOOKING_MY_BOOKINGS,
        alive
      );
    } catch {
      /* best-effort */
    }
  }

  private auth = AuthService.getInstance();
  private transport = NostrTransport.getInstance();

  // ========== Owner: config (kind 30078) ==========

  /** Publish (create or update) the booking config. Replaceable per d-tag. */
  public async publishConfig(config: BookingConfig): Promise<NostrEvent> {
    const user = this.auth.getCurrentUser();
    if (!user) throw new Error('Not logged in');

    const unsigned = {
      kind: BOOKING_CONFIG_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', BOOKING_CONFIG_DTAG],
        ['t', BOOKING_HASHTAG],
        ['title', config.title],
      ],
      content: JSON.stringify(config),
      pubkey: user.pubkey,
    };
    const signed = await this.auth.signEvent(unsigned);
    if (!signed) throw new Error('Signing failed');

    await this.transport.publishWithOutbox(signed, {
      authorPubkeys: [user.pubkey],
    });
    diagLog('system', 'booking: config published', {
      enabled: config.enabled,
      slotMinutes: config.slotMinutes,
      horizonDays: config.horizonDays,
    });
    return signed;
  }

  /** Fetch the booking config of any pubkey (public — powers PV icon + page). */
  public async fetchConfigForPubkey(
    pubkey: string
  ): Promise<BookingConfig | null> {
    // Local wipe (own calendar Reset) not yet published: own config reads
    // default until the wipe is published — other owners are unaffected.
    const { CalendarDataService } = await import('./CalendarDataService');
    const ownPubkey = AuthService.getInstance().getCurrentUser()?.pubkey;
    if (
      ownPubkey &&
      pubkey === ownPubkey &&
      CalendarDataService.getInstance().isLocalWiped()
    ) {
      return null;
    }

    const relays = await resolveCalendarRelays([pubkey]);
    if (relays.length === 0) return null;
    const raw = await this.transport.fetchDirect(
      relays,
      [
        {
          kinds: [BOOKING_CONFIG_KIND as NDKKind],
          authors: [pubkey],
          '#d': [BOOKING_CONFIG_DTAG],
          limit: 1,
        },
      ],
      FETCH_TIMEOUT_MS,
      'booking-config'
    );
    const latest = raw.sort((a, b) => b.created_at - a.created_at)[0];
    if (!latest) return null;
    try {
      return parseBookingConfig(JSON.parse(latest.content));
    } catch {
      diagLog('system', 'booking: config parse failed', { pubkey });
      return null;
    }
  }

  // ========== Slots (kind 31923, t=booking) ==========

  /**
   * Fetch an owner's booking slots with accepted-RSVP status.
   * `includePast` also returns slots that already ended (owner diff needs them).
   */
  public async fetchOwnerSlots(
    ownerPubkey: string,
    options?: { includePast?: boolean }
  ): Promise<OwnerSlot[]> {
    // Local wipe (own calendar Reset) not yet published: own slots stay
    // hidden — other owners' booking pages are unaffected.
    const { CalendarDataService } = await import('./CalendarDataService');
    const ownPubkey = AuthService.getInstance().getCurrentUser()?.pubkey;
    if (
      ownPubkey &&
      ownerPubkey === ownPubkey &&
      CalendarDataService.getInstance().isLocalWiped()
    ) {
      return [];
    }

    const relays = await resolveCalendarRelays([ownerPubkey]);
    if (relays.length === 0) return [];

    const rawSlots = await this.transport.fetchDirect(
      relays,
      [
        {
          kinds: [31923 as NDKKind],
          authors: [ownerPubkey],
          '#t': [BOOKING_HASHTAG],
          limit: 500,
        },
      ],
      FETCH_TIMEOUT_MS,
      'booking-slots'
    );

    // Kind-5 tombstones (deletions) — same pattern as CalendarDataService.
    const deletionEvents = await this.transport.fetchDirect(
      relays,
      [{ kinds: [5], authors: [ownerPubkey], limit: 100 }],
      FETCH_TIMEOUT_MS,
      'booking-deletions'
    );
    const surviving = dedupeByCoordinateWithTombstones(
      rawSlots,
      deletionEvents,
      COORD_PREFIXES
    );

    const now = Date.now();
    const slots: CalendarEventData[] = [];
    for (const ev of surviving) {
      const parsed = parseCalendarEvent(ev);
      if (!parsed) continue;
      if (!parsed.dTag.startsWith(BOOKING_SLOT_DTAG_PREFIX)) continue;
      if (!options?.includePast && (parsed.endMs ?? parsed.startMs) < now) {
        continue;
      }
      slots.push(parsed);
    }
    slots.sort((a, b) => a.startMs - b.startMs);
    if (slots.length === 0) return [];
    // Accepted RSVPs per slot coordinate (latest per responder wins).
    const coordinates = slots.map(s => s.coordinate);
    const rawRsvps = await this.transport.fetchDirect(
      relays,
      [{ kinds: [31925 as NDKKind], '#a': coordinates, limit: 500 }],
      FETCH_TIMEOUT_MS,
      'booking-rsvps'
    );
    const latestByResponder = new Map<string, NostrEvent>();
    for (const ev of rawRsvps) {
      const prev = latestByResponder.get(ev.pubkey);
      if (!prev || ev.created_at > prev.created_at) {
        latestByResponder.set(ev.pubkey, ev);
      }
    }

    const acceptedByCoordinate = new Map<
      string,
      { responder: string; participants: string[] }
    >();
    for (const [, ev] of latestByResponder) {
      const status = ev.tags.find(t => t[0] === 'status')?.[1];
      if (status !== 'accepted') continue;
      const coordinate = ev.tags.find(t => t[0] === 'a')?.[1];
      if (!coordinate) continue;
      // Additional participants travel as p-tags on the RSVP (guest carries
      // them when booking) — visible to every party reading the event.
      const participants = (ev.tags ?? [])
        .filter(t => t[0] === 'p' && t[1] && t[1] !== ev.pubkey)
        .map(t => t[1]!);
      acceptedByCoordinate.set(coordinate, {
        responder: ev.pubkey,
        participants,
      });
    }

    const me = this.auth.getCurrentUser()?.pubkey ?? '';
    return slots.map(data => {
      const booking = acceptedByCoordinate.get(data.coordinate);
      return {
        data,
        bookedBy: booking?.responder ?? null,
        bookedByMe: booking?.responder === me,
        participants: booking?.participants ?? [],
      };
    });
  }

  /**
   * d-tags of the own booking slots that carry an accepted RSVP (booked).
   * Used by the calendar grid to highlight taken slots in green.
   */
  public async getBookedSlotDTags(ownerPubkey: string): Promise<Set<string>> {
    const slots = await this.fetchOwnerSlots(ownerPubkey, {
      includePast: true,
    });
    return new Set(slots.filter(s => s.bookedBy).map(s => s.data.dTag));
  }

  /**
   * Rebuild materialized slots from the config: diff desired (computed) vs.
   * existing (relay state) into publishes and deletions. Deterministic
   * d-tags make unchanged slots no-ops.
   */
  public async rebuildSlots(config: BookingConfig): Promise<RebuildResult> {
    const user = this.auth.getCurrentUser();
    if (!user) throw new Error('Not logged in');

    // Disabled booking = empty desired set: existing future slots get deleted,
    // nothing new is published (the config event itself keeps the settings).
    const desired = config.enabled
      ? computeBookingSlots(config, Date.now())
      : [];
    const desiredByDTag = new Map(desired.map(s => [s.dTag, s]));

    const existing = await this.fetchOwnerSlots(user.pubkey, {
      includePast: true,
    });
    const existingByDTag = new Map(existing.map(s => [s.data.dTag, s]));

    const publishService = CalendarPublishService.getInstance();
    let published = 0;
    let deleted = 0;

    for (const [dTag, slot] of desiredByDTag) {
      if (existingByDTag.has(dTag)) continue;
      const draft: CalendarEventDraft = {
        dTag,
        allDay: false,
        title: config.title || 'Appointment',
        description: config.description,
        startMs: slot.startMs,
        endMs: slot.endMs,
        location: '',
        image: '',
        repeat: null,
        hashtags: [BOOKING_HASHTAG],
      };
      try {
        await publishService.publishEvent(draft);
        published++;
      } catch (err) {
        diagLog('system', 'booking: slot publish failed', {
          dTag,
          error: String(err),
        });
      }
    }

    const toDelete: CalendarEventData[] = [];
    for (const [dTag, ownerSlot] of existingByDTag) {
      if (desiredByDTag.has(dTag)) continue;
      // Only delete slots this rebuild owns: future slots that fell out of
      // the desired set (rule change / vacation). Past slots stay as history.
      if ((ownerSlot.data.endMs ?? ownerSlot.data.startMs) < Date.now()) {
        continue;
      }
      toDelete.push(ownerSlot.data);
    }

    if (toDelete.length > 0) {
      // ONE grouped kind-5 + ONE silent breadth pass — no toast spam.
      const ok = await publishService.deleteEventsBulk(toDelete);
      deleted = ok ? toDelete.length : 0;
    }

    diagLog('system', 'booking: slots rebuilt', { published, deleted });
    return { published, deleted };
  }

  // ========== Guest: book a slot ==========

  /**
   * Book a slot as the current user: accepted RSVP (public, collision
   * protection) + NIP-17 DM to the owner with the booking summary. Guest
   * name/note travel ONLY in the DM.
   */
  public async bookSlot(
    slot: CalendarEventData,
    guestName: string,
    note: string,
    participants: string[] = []
  ): Promise<BookingOpResult> {
    const user = this.auth.getCurrentUser();
    if (!user) throw new Error('Sign in to book an appointment');

    const published = await CalendarPublishService.getInstance().publishRSVP(
      slot,
      'accepted',
      '',
      participants.map(p => ['p', p])
    );
    if (!published) {
      return {
        ok: false,
        detail:
          'The booking could not be published — no relay accepted it. Check your connection and try again.',
        informed: 0,
        dmFailures: 0,
      };
    }

    const lines = [
      `📅 New booking: ${slot.title}`,
      `When: ${new Date(slot.startMs).toUTCString()}`,
    ];
    if (guestName.trim()) lines.push(`Name: ${guestName.trim()}`);
    if (note.trim()) lines.push(`Note: ${note.trim()}`);
    lines.push(`Booked by: ${encodeNpub(user.pubkey)}`);
    const summary = lines.join('\n');

    const dms = ModuleLoader.getInstance().getApi<DMsModuleApi>('dms');

    // Guest-side reminder record (device-local, per account) + reschedule —
    // only after the relay publish was confirmed.
    this.saveMyBookingRecord({
      ownerPubkey: slot.pubkey,
      dTag: slot.dTag,
      title: slot.title,
      startMs: slot.startMs,
      endMs: slot.endMs ?? slot.startMs,
      guestName: guestName.trim(),
      note: note.trim(),
      participants,
    });
    this.hub.rescheduleSoon(REMINDER_NAMESPACE_GUEST);

    let informed = 0;
    let dmFailures = 0;
    if (!dms) {
      // Booking stands — only the notification DMs are lost.
      diagLog('system', 'booking: dm module unavailable', {
        dTag: slot.dTag,
      });
      return {
        ok: true,
        detail: 'Booked — notification module unavailable',
        informed: 0,
        dmFailures: 0,
      };
    }
    try {
      await dms.sendMessage(slot.pubkey, summary);
      informed++;
    } catch (err) {
      dmFailures++;
      diagLog('system', 'booking: dm owner failed', { error: String(err) });
    }

    // Additional participants: their own copy of the summary — failures are
    // non-fatal (the booking itself already exists via the RSVP).
    for (const participant of participants) {
      if (participant === user.pubkey || participant === slot.pubkey) continue;
      try {
        await dms.sendMessage(
          participant,
          `📅 You are included as a participant of a meeting that was just booked:\n\n${summary}`
        );
        informed++;
      } catch (err) {
        dmFailures++;
        diagLog('system', 'booking: participant dm failed', {
          error: String(err),
        });
      }
    }

    diagLog('system', 'booking: slot booked', {
      dTag: slot.dTag,
      informed,
      dmFailures,
    });
    return {
      ok: true,
      detail: dmFailures
        ? `Booked — ${informed} DM(s) sent, ${dmFailures} failed`
        : 'Booked',
      informed,
      dmFailures,
    };
  }

  /**
   * Guest cancels their own booking: declined RSVP (same parameterized d-tag,
   * latest status wins → slot is free again), reason goes into the RSVP
   * content and the notification DMs. Also removes the calendar import,
   * the local record and the guest reminder.
   */
  public async cancelBooking(
    slot: CalendarEventData,
    reason: string
  ): Promise<BookingOpResult> {
    const user = this.auth.getCurrentUser();
    if (!user) throw new Error('Sign in to manage your booking');

    const published = await CalendarPublishService.getInstance().publishRSVP(
      slot,
      'declined',
      reason
    );
    if (!published) {
      return {
        ok: false,
        detail:
          'The cancellation could not be published — no relay accepted it. Check your connection and try again.',
        informed: 0,
        dmFailures: 0,
      };
    }

    const { informed, dmFailures } = await this.notifyAndCleanupCancellation(
      slot,
      reason
    );
    return {
      ok: true,
      detail:
        informed > 0
          ? `Booking cancelled — host and ${informed - 1} participant(s) informed`
          : 'Booking cancelled',
      informed,
      dmFailures,
    };
  }

  /**
   * Notification + device cleanup for a guest cancellation — WITHOUT
   * publishing the RSVP. Called by cancelBooking (after the declined RSVP)
   * AND by the generic RSVP bar path (CalendarEventModal "Can't go" on a
   * bookslot- event), so both guest cancel paths inform owner + participants
   * identically.
   */
  public async notifyAndCleanupCancellation(
    slot: CalendarEventData,
    reason: string
  ): Promise<{ informed: number; dmFailures: number }> {
    const user = this.auth.getCurrentUser();
    if (!user) return { informed: 0, dmFailures: 0 };

    // Guest name + original note from the booking record — so recipients can
    // associate the cancellation with the right appointment.
    const record = this.getMyBookings().find(r => r.dTag === slot.dTag);
    const dms = ModuleLoader.getInstance().getApi<DMsModuleApi>('dms');
    const cancelNote = [
      `❌ Booking cancelled: ${slot.title}`,
      `When: ${new Date(slot.startMs).toUTCString()}`,
      record?.guestName ? `Name: ${record.guestName}` : null,
      record?.note ? `Note: ${record.note}` : null,
      `Reason: ${reason.trim() || '—'}`,
      `By: ${encodeNpub(user.pubkey)}`,
    ]
      .filter((line): line is string => line !== null)
      .join('\n');

    let informed = 0;
    let dmFailures = 0;
    if (dms) {
      try {
        await dms.sendMessage(slot.pubkey, cancelNote);
        informed++;
      } catch (err) {
        dmFailures++;
        diagLog('system', 'booking: cancel dm owner failed', {
          error: String(err),
        });
      }
      // Participants travel on the local record (guest-side knowledge).
      for (const participant of record?.participants ?? []) {
        try {
          await dms.sendMessage(participant, cancelNote);
          informed++;
        } catch (err) {
          dmFailures++;
          diagLog('system', 'booking: cancel dm participant failed', {
            error: String(err),
          });
        }
      }
    }

    try {
      const { CalendarDataService } = await import('./CalendarDataService');
      CalendarDataService.getInstance().unsaveEvent(slot.coordinate);
    } catch {
      /* best-effort */
    }
    this.removeMyBookingRecord(slot.dTag);
    this.hub.rescheduleSoon(REMINDER_NAMESPACE_GUEST);

    diagLog('system', 'booking: slot cancelled', {
      dTag: slot.dTag,
      informed,
      dmFailures,
    });
    return { informed, dmFailures };
  }

  /**
   * Owner cancels a booking on their own slot: the slot event is deleted
   * (reason in the kind-5 content) and the guest + participants are informed
   * via DM. Guest + participants are known from the public RSVP.
   */
  public async ownerCancelBooking(
    slot: CalendarEventData,
    reason: string,
    guestPubkey: string,
    participants: string[]
  ): Promise<BookingOpResult> {
    const user = this.auth.getCurrentUser();
    if (!user) throw new Error('Not logged in');

    const deleted = await CalendarPublishService.getInstance().deleteEvent(
      slot,
      reason
    );
    if (!deleted) {
      return {
        ok: false,
        detail:
          'The cancellation was not accepted by any relay. Check your connection and try again.',
        informed: 0,
        dmFailures: 0,
      };
    }

    const dms = ModuleLoader.getInstance().getApi<DMsModuleApi>('dms');
    const note = `❌ The host cancelled the booking "${slot.title}"\nWhen: ${new Date(slot.startMs).toUTCString()}\nReason: ${reason.trim() || '—'}`;
    const recipients = [guestPubkey, ...participants].filter(
      (p, i, all) => p && p !== user.pubkey && all.indexOf(p) === i
    );

    let informed = 0;
    let dmFailures = 0;
    if (dms) {
      for (const recipient of recipients) {
        try {
          await dms.sendMessage(recipient, note);
          informed++;
        } catch (err) {
          dmFailures++;
          diagLog('system', 'booking: cancel dm failed', {
            recipient,
            error: String(err),
          });
        }
      }
    }

    diagLog('system', 'booking: owner cancelled booking', {
      dTag: slot.dTag,
      informed,
      dmFailures,
    });
    return {
      ok: true,
      detail: informed
        ? `Booking cancelled — ${informed} recipient(s) informed`
        : 'Booking cancelled',
      informed,
      dmFailures,
    };
  }

  /**
   * Owner cancels a booked slot directly from the event modal: resolves the
   * accepted responders (+ their p-tag participants) from the public RSVPs,
   * deletes the slot (reason in the kind-5 content) and informs everyone by
   * DM. Used by CalendarEventModal's delete on a booked slot.
   */
  public async cancelBookingAsOwner(
    event: CalendarEventData,
    reason: string
  ): Promise<BookingOpResult> {
    const user = this.auth.getCurrentUser();
    if (!user) throw new Error('Not logged in');

    const relays = await resolveCalendarRelays([user.pubkey]);
    const raw = await this.transport.fetchDirect(
      relays,
      [{ kinds: [31925 as NDKKind], '#a': [event.coordinate], limit: 200 }],
      FETCH_TIMEOUT_MS,
      'booking-cancel'
    );

    const latestByResponder = new Map<string, NostrEvent>();
    for (const ev of raw) {
      const prev = latestByResponder.get(ev.pubkey);
      if (!prev || ev.created_at > prev.created_at) {
        latestByResponder.set(ev.pubkey, ev);
      }
    }

    const guests: { responder: string; participants: string[] }[] = [];
    for (const [, ev] of latestByResponder) {
      if (ev.tags.find(t => t[0] === 'status')?.[1] !== 'accepted') continue;
      guests.push({
        responder: ev.pubkey,
        participants: (ev.tags ?? [])
          .filter(t => t[0] === 'p' && t[1] && t[1] !== ev.pubkey)
          .map(t => t[1]!),
      });
    }

    const deleted = await CalendarPublishService.getInstance().deleteEvent(
      event,
      reason
    );
    if (!deleted) {
      return {
        ok: false,
        detail: 'The cancellation was not accepted by any relay. Try again.',
        informed: 0,
        dmFailures: 0,
      };
    }

    const dms = ModuleLoader.getInstance().getApi<DMsModuleApi>('dms');
    const note = `❌ The host cancelled the booking "${event.title}"\nWhen: ${new Date(event.startMs).toUTCString()}\nReason: ${reason.trim() || '—'}`;
    let informed = 0;
    let dmFailures = 0;
    if (dms) {
      for (const guest of guests) {
        const recipients = [guest.responder, ...guest.participants].filter(
          (p, i, all) => p && p !== user.pubkey && all.indexOf(p) === i
        );
        for (const recipient of recipients) {
          try {
            await dms.sendMessage(recipient, note);
            informed++;
          } catch (err) {
            dmFailures++;
            diagLog('system', 'booking: cancel dm failed', {
              recipient,
              error: String(err),
            });
          }
        }
      }
    }

    diagLog('system', 'booking: owner cancelled via modal', {
      dTag: event.dTag,
      informed,
      dmFailures,
    });
    return {
      ok: true,
      detail: informed
        ? `Booking cancelled — ${informed} recipient(s) informed`
        : 'Booking cancelled',
      informed,
      dmFailures,
    };
  }

  /** Owner device: rebuild the reminders for all booked slots. */
  public rescheduleOwnerReminders(): void {
    this.hub.rescheduleSoon(REMINDER_NAMESPACE_OWNER);
  }
}
