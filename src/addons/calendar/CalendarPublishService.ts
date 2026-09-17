/**
 * CalendarPublishService — write paths for NIP-52 calendar data (phase 2).
 *
 * Publishing rules (AGENTS.md): sign via AuthService.signEvent(), publish via
 * NostrTransport (publishWithOutbox → own NIP-65 write relays). Deletions via
 * the central DeletionService. RSVPs are kind 31925, parameterized
 * replaceable per (responder, event) — a deterministic d-tag makes the latest
 * status win, exactly like the Form* reference.
 */

import type { NostrEvent, NDKKind } from '@nostr-dev-kit/ndk';
import { AuthService } from '../../services/AuthService';
import { NostrTransport } from '../../services/transport/NostrTransport';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { PostsModuleApi } from '../../modules/posts/contracts';
import { diagLog } from '../../services/DiagnosticLogger';
import { resolveCalendarRelays } from './relays';
import {
  buildRecurrenceRule,
  type RecurrenceFrequency,
} from '../../helpers/nip52/recurrence';
import {
  calendarEventToTags,
  type CalendarEventData,
} from '../../helpers/nip52/parser';

export type RSVPStatusValue = 'accepted' | 'declined' | 'tentative';

/** Editable shape used by the editor modal. */
export interface CalendarEventDraft {
  /** Existing d-tag (edit) or a fresh one (create). */
  dTag: string;
  /** 31923 = timed, 31922 = all-day. */
  allDay: boolean;
  title: string;
  description: string;
  startMs: number;
  /** null = no end (timed) / same-day (all-day, per NIP-52 omission). */
  endMs: number | null;
  location: string;
  image: string;
  /** null = one-off; otherwise an NIP-52R frequency. */
  repeat: RecurrenceFrequency | null;
}

export interface RSVPSummary {
  accepted: number;
  declined: number;
  tentative: number;
  /** The current user's status, or null when they have not responded. */
  mine: RSVPStatusValue | null;
}

const RANDOM_DTAG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function generateDTag(): string {
  let out = '';
  for (let i = 0; i < 16; i++) {
    out +=
      RANDOM_DTAG_ALPHABET[
        Math.floor(Math.random() * RANDOM_DTAG_ALPHABET.length)
      ];
  }
  return out;
}

export class CalendarPublishService {
  private static instance: CalendarPublishService | null = null;

  public static getInstance(): CalendarPublishService {
    if (!CalendarPublishService.instance) {
      CalendarPublishService.instance = new CalendarPublishService();
    }
    return CalendarPublishService.instance;
  }

  public static resetInstance(): void {
    CalendarPublishService.instance = null;
  }

  private readonly auth = AuthService.getInstance();
  private readonly transport = NostrTransport.getInstance();

  /** Publish (create or update) a calendar event from an editor draft. */
  public async publishEvent(draft: CalendarEventDraft): Promise<NostrEvent> {
    const user = this.auth.getCurrentUser();
    if (!user) throw new Error('Not logged in');

    const kind = draft.allDay ? 31922 : 31923;
    const startMs = draft.startMs;
    let endMs = draft.endMs;
    if (endMs !== null && endMs <= startMs) endMs = null;

    const model: CalendarEventData = {
      coordinate: `${kind}:${user.pubkey}:${draft.dTag}`,
      eventId: '',
      kind,
      pubkey: user.pubkey,
      dTag: draft.dTag,
      title: draft.title.trim(),
      description: draft.description.trim(),
      startMs,
      endMs,
      allDay: draft.allDay,
      image: draft.image.trim() || undefined,
      locations: draft.location.trim() ? [draft.location.trim()] : [],
      geoHashes: [],
      participants: [],
      hashtags: [],
      links: [],
      rrule: draft.repeat
        ? buildRecurrenceRule({ frequency: draft.repeat, startMs })
        : null,
      createdAt: Math.floor(Date.now() / 1000),
    };

    if (!model.title) throw new Error('Title is required');

    const unsigned = {
      kind,
      created_at: model.createdAt,
      tags: calendarEventToTags(model),
      content: model.description,
      pubkey: user.pubkey,
    };
    const signed = await this.auth.signEvent(unsigned);
    if (!signed) throw new Error('Signing failed');

    await this.transport.publishWithOutbox(signed, {
      authorPubkeys: [user.pubkey],
    });
    diagLog('system', 'calendar: event published', {
      kind,
      dTag: draft.dTag,
      edit: !!model.eventId,
    });
    return signed;
  }

  /**
   * Delete an own calendar event or collection (NIP-09).
   *
   * Two-step on purpose: (1) publish the kind-5 DIRECTLY to the calendar
   * relay set (read + aggregator + own NIP-65 outbox) — exactly where the
   * event lives; DeletionService only covers the user's active Settings
   * relays, which can miss outbox-only relays and leaves the event alive
   * there forever. (2) then DeletionService (posts module) for breadth:
   * all settings relays + the background broadcast to 1000+ relays.
   */
  public async deleteEvent(event: CalendarEventData): Promise<boolean> {
    const user = this.auth.getCurrentUser();
    if (!user) throw new Error('Not logged in');

    const unsigned = {
      kind: 5,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['a', event.coordinate],
        ['k', String(event.kind)],
      ],
      content: `Deleted calendar event "${event.title}"`,
      pubkey: user.pubkey,
    };
    const signed = await this.auth.signEvent(unsigned);
    if (!signed) throw new Error('Signing failed');

    const relays = await resolveCalendarRelays([user.pubkey]);
    const accepted = await this.transport.publish(relays, signed);

    // Breadth pass (settings relays + 1000+ background broadcast). The
    // own-relay publish above already guarantees the delete lands where the
    // event lives.
    try {
      const posts = ModuleLoader.getInstance().getApi<PostsModuleApi>('posts');
      void posts?.deleteByCoordinates(
        [event.coordinate],
        `Deleted calendar event "${event.title}"`
      );
    } catch {
      // Breadth pass is best-effort.
    }

    // Remove from the local cache immediately so the grid is clean even if
    // relays are slow to serve the deletion back.
    const { CalendarDataService } = await import('./CalendarDataService');
    CalendarDataService.getInstance().removeEventFromCache(event.coordinate);

    diagLog('system', 'calendar: event deleted', {
      dTag: event.dTag,
      acceptedRelays: accepted.size,
    });
    return accepted.size > 0;
  }

  /** Publish the current user's RSVP (kind 31925) for an event. */
  public async publishRSVP(
    event: CalendarEventData,
    status: RSVPStatusValue,
    comment = ''
  ): Promise<void> {
    const user = this.auth.getCurrentUser();
    if (!user) throw new Error('Not logged in');

    const dTag = `${user.pubkey}:${event.pubkey}:${event.dTag}`;
    const unsigned = {
      kind: 31925,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['a', event.coordinate],
        ['d', dTag],
        ['status', status],
      ],
      content: comment,
      pubkey: user.pubkey,
    };
    const signed = await this.auth.signEvent(unsigned);
    if (!signed) throw new Error('Signing failed');

    await this.transport.publishWithOutbox(signed, {
      authorPubkeys: [user.pubkey],
    });
    diagLog('system', 'calendar: rsvp published', { status, dTag: event.dTag });
  }

  /**
   * Fetch all kind-31925 RSVPs for an event coordinate and aggregate them.
   * Latest created_at per responder wins (parameterized replaceable).
   */
  public async fetchRSVPSummary(
    event: CalendarEventData
  ): Promise<RSVPSummary> {
    const user = this.auth.getCurrentUser();
    const summary: RSVPSummary = {
      accepted: 0,
      declined: 0,
      tentative: 0,
      mine: null,
    };

    const relays = await resolveCalendarRelays([
      event.pubkey,
      ...event.participants,
    ]);
    const raw = await this.transport.fetchDirect(
      relays,
      [{ kinds: [31925 as NDKKind], '#a': [event.coordinate], limit: 200 }],
      6000,
      'calendar-rsvps'
    );

    const latestByResponder = new Map<string, NostrEvent>();
    for (const ev of raw) {
      const prev = latestByResponder.get(ev.pubkey);
      if (!prev || ev.created_at > prev.created_at) {
        latestByResponder.set(ev.pubkey, ev);
      }
    }

    for (const [pubkey, ev] of latestByResponder) {
      const status = ev.tags.find(t => t[0] === 'status')?.[1];
      if (
        status !== 'accepted' &&
        status !== 'declined' &&
        status !== 'tentative'
      ) {
        continue;
      }
      summary[status]++;
      if (user && pubkey === user.pubkey) summary.mine = status;
    }
    return summary;
  }
}
