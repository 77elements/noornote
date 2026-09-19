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

export interface OwnerSlot {
  /** Parsed slot event. */
  data: CalendarEventData;
  /** Accepted-RSVP responder pubkey, or null when the slot is free. */
  bookedBy: string | null;
}

export interface RebuildResult {
  published: number;
  deleted: number;
}

export class BookingService {
  private static instance: BookingService | null = null;

  public static getInstance(): BookingService {
    if (!BookingService.instance) {
      BookingService.instance = new BookingService();
    }
    return BookingService.instance;
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

    const acceptedByCoordinate = new Map<string, string>();
    for (const [, ev] of latestByResponder) {
      const status = ev.tags.find(t => t[0] === 'status')?.[1];
      if (status !== 'accepted') continue;
      const coordinate = ev.tags.find(t => t[0] === 'a')?.[1];
      if (!coordinate) continue;
      acceptedByCoordinate.set(coordinate, ev.pubkey);
    }

    return slots.map(data => ({
      data,
      bookedBy: acceptedByCoordinate.get(data.coordinate) ?? null,
    }));
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

    for (const [dTag, ownerSlot] of existingByDTag) {
      if (desiredByDTag.has(dTag)) continue;
      // Only delete slots this rebuild owns: future slots that fell out of
      // the desired set (rule change / vacation). Past slots stay as history.
      if ((ownerSlot.data.endMs ?? ownerSlot.data.startMs) < Date.now()) {
        continue;
      }
      try {
        await publishService.deleteEvent(ownerSlot.data);
        deleted++;
      } catch (err) {
        diagLog('system', 'booking: slot delete failed', {
          dTag,
          error: String(err),
        });
      }
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
    note: string
  ): Promise<void> {
    const user = this.auth.getCurrentUser();
    if (!user) throw new Error('Sign in to book an appointment');

    await CalendarPublishService.getInstance().publishRSVP(
      slot,
      'accepted',
      ''
    );

    const lines = [
      `📅 New booking: ${slot.title}`,
      `When: ${new Date(slot.startMs).toUTCString()}`,
    ];
    if (guestName.trim()) lines.push(`Name: ${guestName.trim()}`);
    if (note.trim()) lines.push(`Note: ${note.trim()}`);
    lines.push(`Booked by: ${encodeNpub(user.pubkey)}`);

    const dms = ModuleLoader.getInstance().getApi<DMsModuleApi>('dms');
    if (!dms) {
      // RSVP already won — the booking stands; only the summary DM is lost.
      diagLog('system', 'booking: dm module unavailable', {
        dTag: slot.dTag,
      });
      return;
    }
    const sent = await dms.sendMessage(slot.pubkey, lines.join('\n'));
    diagLog('system', 'booking: slot booked', {
      dTag: slot.dTag,
      dmSent: sent,
    });
    if (!sent) {
      // RSVP won — booking is valid even if the DM transport hiccups.
      diagLog('system', 'booking: dm send failed', { dTag: slot.dTag });
    }
  }
}
