/**
 * PrivateCalendarService — phase 3a: private calendar events, Form*-style
 * (NIP-52E draft).
 *
 * Data model:
 *   - Private events live as kind 32678/32679 with an NIP-44-encrypted
 *     payload (one-time view key, local crypto).
 *   - The user's private calendar list is ONE kind 32123 event
 *     (d-tag `noornote-private`), NIP-44 self-encrypted to the user's own
 *     keypair via AuthService (signer-agnostic). Each ref carries the event's
 *     view key + a relay hint → multi-device sync over relays.
 *
 * The list is the source of truth: without its ref (view key) an event's
 * payload is undecryptable, so events are only fetched through it.
 */

import type { NDKKind } from '@nostr-dev-kit/ndk';
import { NostrTransport } from '../../services/transport/NostrTransport';
import { AuthService } from '../../services/AuthService';
import { diagLog } from '../../services/DiagnosticLogger';
import type { PostsModuleApi } from '../../modules/posts/contracts';
import { getPublicKeyFromPrivate } from '../../services/NostrToolsAdapter';
import {
  buildCalendarCoordinate,
  parseCalendarEvent,
  PRIVATE_EVENT_KIND,
  PRIVATE_LIST_KIND,
  PRIVATE_RECURRING_EVENT_KIND,
  type CalendarEventData,
} from '../../helpers/nip52/parser';
import {
  buildPrivateEventPayload,
  buildPrivateListPayload,
  decryptWithViewKey,
  DEFAULT_PRIVATE_LIST_ID,
  encryptWithViewKey,
  generateViewKey,
  parsePrivateListPayload,
  type PrivateCalendarList,
  type PrivateEventRef,
  type PrivateViewKey,
} from './privateCalendar';
import { resolveCalendarRelays } from './relays';

const FETCH_TIMEOUT_MS = 8000;

/** Editor-shaped draft (mirrors CalendarEventDraft fields used here). */
export interface PrivateEventDraft {
  dTag: string;
  title: string;
  description: string;
  startMs: number;
  endMs: number | null;
  location: string;
  image: string;
  /** Bare NIP-52R rule or null. */
  rrule: string | null;
  /** Participant pubkeys — receive gift-wrap invitations (phase 3b). */
  participants: string[];
}

export class PrivateCalendarService {
  private static instance: PrivateCalendarService | null = null;

  public static getInstance(): PrivateCalendarService {
    if (!PrivateCalendarService.instance) {
      PrivateCalendarService.instance = new PrivateCalendarService();
    }
    return PrivateCalendarService.instance;
  }

  public static resetInstance(): void {
    PrivateCalendarService.instance = null;
  }

  private readonly transport = NostrTransport.getInstance();
  private readonly auth = AuthService.getInstance();
  private list: PrivateCalendarList | null = null;
  private destroyed = false;

  public getOwnList(): PrivateCalendarList | null {
    return this.list;
  }

  /**
   * Fetch the private list (kind 32123), then every referenced event, decrypt
   * and parse them. Auto-publishes the default list on first use so other
   * devices can sync into it.
   */
  public async fetchOwnPrivateEvents(): Promise<CalendarEventData[]> {
    const user = this.auth.getCurrentUser();
    if (!user || this.destroyed) return [];

    const relays = await resolveCalendarRelays([user.pubkey]);
    const listEvents = await this.transport.fetchDirect(
      relays,
      [
        {
          kinds: [PRIVATE_LIST_KIND as NDKKind],
          authors: [user.pubkey],
          limit: 10,
        },
      ],
      FETCH_TIMEOUT_MS,
      'calendar-private-list'
    );

    // Latest wins (parameterized replaceable by d-tag).
    const latest = listEvents
      .filter(
        ev => ev.tags.find(t => t[0] === 'd')?.[1] === DEFAULT_PRIVATE_LIST_ID
      )
      .sort((a, b) => b.created_at - a.created_at)[0];

    if (!latest) {
      await this.publishList(
        {
          title: 'Private',
          description: '',
          eventRefs: [],
        },
        user.pubkey
      );
      this.list = {
        id: DEFAULT_PRIVATE_LIST_ID,
        title: 'Private',
        description: '',
        createdAt: Math.floor(Date.now() / 1000),
        eventRefs: [],
      };
      return [];
    }

    const plaintext = await this.auth.nip44Decrypt(latest.content, user.pubkey);
    const parsedList = parsePrivateListPayload(
      plaintext,
      DEFAULT_PRIVATE_LIST_ID,
      latest.created_at
    );
    if (!parsedList) {
      diagLog('system', 'calendar: private list decrypt failed');
      return [];
    }
    this.list = parsedList;

    // Fetch referenced events, grouped by author.
    const byAuthor = new Map<string, PrivateEventRef[]>();
    for (const ref of parsedList.eventRefs) {
      const author = ref.coordinate.split(':')[1];
      if (!author) continue;
      const group = byAuthor.get(author) ?? [];
      group.push(ref);
      byAuthor.set(author, group);
    }

    const events: CalendarEventData[] = [];
    for (const [author, refs] of byAuthor) {
      const raw = await this.transport.fetchDirect(
        relays,
        [
          {
            kinds: [PRIVATE_EVENT_KIND, PRIVATE_RECURRING_EVENT_KIND].map(
              kind => kind as NDKKind
            ),
            authors: [author],
            '#d': refs.map(ref => ref.coordinate.split(':')[2] ?? ''),
            limit: 200,
          },
        ],
        FETCH_TIMEOUT_MS,
        'calendar-private-events'
      );
      for (const ev of raw) {
        const evKind = ev.kind ?? 0;
        const dTag = ev.tags.find(t => t[0] === 'd')?.[1] ?? '';
        const ref = refs.find(
          candidate =>
            candidate.coordinate ===
            buildCalendarCoordinate(evKind, ev.pubkey, dTag)
        );
        if (!ref) continue;
        const payload = decryptWithViewKey<string[][]>(
          ev.content,
          ref.viewSecretHex
        );
        if (!payload) continue;
        const parsed = parseCalendarEvent({
          id: ev.id,
          kind: evKind,
          pubkey: ev.pubkey,
          created_at: ev.created_at,
          content: '',
          tags: payload,
        });
        if (parsed) {
          parsed.viewSecretHex = ref.viewSecretHex;
          parsed.listId = parsedList.id;
          events.push(parsed);
        }
      }
    }

    diagLog('system', 'calendar: private events fetched', {
      lists: 1,
      events: events.length,
    });
    return events;
  }

  /**
   * Publish (create/update) a private event and upsert its ref (with the
   * view key) into the default private list. Returns the parsed model.
   */
  public async publishPrivateEvent(
    draft: PrivateEventDraft
  ): Promise<CalendarEventData> {
    const user = this.auth.getCurrentUser();
    if (!user) throw new Error('Not logged in');
    if (this.destroyed) throw new Error('Service destroyed');

    // Reuse the view key on edits so other devices keep decrypting.
    const existingRef = this.list?.eventRefs.find(ref =>
      ref.coordinate.endsWith(`:${draft.dTag}`)
    );
    const viewKey: PrivateViewKey = existingRef
      ? {
          secretHex: existingRef.viewSecretHex,
          pubkeyHex: getPublicKeyFromPrivate(existingRef.viewSecretHex),
          nsec: '',
        }
      : generateViewKey();

    const kind = draft.rrule
      ? PRIVATE_RECURRING_EVENT_KIND
      : PRIVATE_EVENT_KIND;
    const payload = buildPrivateEventPayload({
      ...draft,
      participants: draft.participants.filter(p => p && p !== user.pubkey),
    });
    const content = encryptWithViewKey(
      JSON.stringify(payload),
      viewKey.secretHex
    );

    const unsigned = {
      kind,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', draft.dTag]],
      content,
      pubkey: user.pubkey,
    };
    const signed = await this.auth.signEvent(unsigned);
    if (!signed) throw new Error('Signing failed');

    const relaySet = await this.transport.publishWithOutbox(signed, {
      authorPubkeys: [user.pubkey],
    });

    // Upsert the list ref (view key makes the payload readable on any device).
    const coordinate = buildCalendarCoordinate(kind, user.pubkey, draft.dTag);
    const relayHint = [...relaySet][0] ?? existingRef?.relayHint ?? '';
    const ref: PrivateEventRef = {
      coordinate,
      relayHint,
      viewSecretHex: viewKey.secretHex,
    };
    const list = this.list ?? {
      id: DEFAULT_PRIVATE_LIST_ID,
      title: 'Private',
      description: '',
      createdAt: 0,
      eventRefs: [],
    };
    const eventRefs = list.eventRefs.filter(
      candidate => candidate.coordinate !== coordinate
    );
    eventRefs.push(ref);
    await this.publishList({ ...list, eventRefs }, user.pubkey);
    this.list = {
      ...list,
      eventRefs,
      createdAt: Math.floor(Date.now() / 1000),
    };

    diagLog('system', 'calendar: private event published', {
      dTag: draft.dTag,
      kind,
      edit: !!existingRef,
    });

    return {
      coordinate,
      eventId: signed.id ?? '',
      kind,
      pubkey: user.pubkey,
      dTag: draft.dTag,
      title: draft.title,
      description: draft.description,
      startMs: draft.startMs,
      endMs: draft.endMs,
      allDay: false,
      image: draft.image || undefined,
      locations: draft.location ? [draft.location] : [],
      geoHashes: [],
      participants: draft.participants.filter(p => p && p !== user.pubkey),
      hashtags: [],
      links: [],
      rrule: draft.rrule,
      createdAt: unsigned.created_at,
      isPrivate: true,
      viewSecretHex: viewKey.secretHex,
      listId: DEFAULT_PRIVATE_LIST_ID,
    };
  }

  /** Delete a private event (NIP-09) and drop its list ref. */
  public async deletePrivateEvent(event: CalendarEventData): Promise<boolean> {
    const { ModuleLoader } = await import('../../core/ModuleLoader');
    const posts = ModuleLoader.getInstance().getApi<PostsModuleApi>('posts');
    const ok =
      (await posts?.deleteByCoordinates(
        [event.coordinate],
        'Deleted private calendar event'
      )) ?? false;
    if (!ok || !this.list) return ok;

    const eventRefs = this.list.eventRefs.filter(
      ref => ref.coordinate !== event.coordinate
    );
    const user = this.auth.getCurrentUser();
    if (user) {
      await this.publishList({ ...this.list, eventRefs }, user.pubkey);
    }
    this.list = { ...this.list, eventRefs };
    diagLog('system', 'calendar: private event deleted', { dTag: event.dTag });
    return ok;
  }

  /**
   * Accept a received invitation: add the event ref (with its view key) to
   * the default private list and republish, so the event shows up in the
   * grid and on every other device.
   */
  public async importInvite(ref: PrivateEventRef): Promise<void> {
    const user = this.auth.getCurrentUser();
    if (!user) throw new Error('Not logged in');

    const list =
      this.list ??
      ({
        id: DEFAULT_PRIVATE_LIST_ID,
        title: 'Private',
        description: '',
        createdAt: 0,
        eventRefs: [],
      } as PrivateCalendarList);

    if (
      list.eventRefs.some(candidate => candidate.coordinate === ref.coordinate)
    ) {
      return;
    }
    const eventRefs = [...list.eventRefs, ref];
    await this.publishList({ ...list, eventRefs }, user.pubkey);
    this.list = {
      ...list,
      eventRefs,
      createdAt: Math.floor(Date.now() / 1000),
    };
    diagLog('system', 'calendar: invite accepted', {
      coordinate: ref.coordinate,
    });
  }

  private async publishList(
    list: Omit<PrivateCalendarList, 'id' | 'createdAt'>,
    userPubkey: string
  ): Promise<void> {
    const plaintext = buildPrivateListPayload(list);
    const content = await this.auth.nip44Encrypt(plaintext, userPubkey);
    const unsigned = {
      kind: PRIVATE_LIST_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', DEFAULT_PRIVATE_LIST_ID]],
      content,
      pubkey: userPubkey,
    };
    const signed = await this.auth.signEvent(unsigned);
    if (!signed) throw new Error('Signing failed');
    await this.transport.publishWithOutbox(signed, {
      authorPubkeys: [userPubkey],
    });
  }

  public destroy(): void {
    this.destroyed = true;
    this.list = null;
    PrivateCalendarService.resetInstance();
  }
}
