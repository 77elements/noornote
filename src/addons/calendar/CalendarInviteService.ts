/**
 * CalendarInviteService — phase 3b: private event invitations + private RSVPs.
 *
 * Invitations ride NIP-59 gift wraps (kind 1059 classified via `["k","1052"]`,
 * legacy kind 1052 read-only). The rumor is kind 14 carrying the event ref
 * (`a` tag), the view key (`viewKey`, nsec or hex) and the ephemeral
 * `signing_nsec` the recipient can use to NIP-09-delete the wrap on dismiss.
 * Wrap creation/unwrapping is REUSED from DMService (shared NIP-17
 * primitive) — see deliverGiftWrap / unwrapGiftWrapEvent.
 *
 * Private RSVPs (kind 32069): { status, comment } encrypted with the event's
 * view key — only view-key holders (owner + invited participants) can read
 * the aggregate.
 */

import type { NostrEvent, NDKKind } from '@nostr-dev-kit/ndk';
import { NostrTransport } from '../../services/transport/NostrTransport';
import { AuthService } from '../../services/AuthService';
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../services/PerAccountLocalStorage';
import { diagLog } from '../../services/DiagnosticLogger';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { DMsModuleApi } from '../../modules/dms/contracts';
import {
  decodeNip19,
  finalizeEventSigning,
  bytesToHex,
} from '../../services/NostrToolsAdapter';
import { resolveCalendarRelays } from './relays';
import {
  decryptWithViewKey,
  encryptWithViewKey,
  isPrivateEventKind,
  type PrivateEventRef,
} from './privateCalendar';
import type { CalendarEventData } from '../../helpers/nip52/parser';
import type { RSVPStatusValue } from './CalendarPublishService';

const FETCH_TIMEOUT_MS = 8000;

export interface CalendarInvite {
  wrapId: string;
  /** `<kind>:<pubkey>:<dTag>` of the private event. */
  coordinate: string;
  authorPubkey: string;
  relayHint: string;
  viewSecretHex: string;
  message?: string | undefined;
  /** Ephemeral wrap key (nsec) — enables NIP-09 self-deletion on dismiss. */
  signingNsec?: string | undefined;
  createdAt: number;
}

export interface PrivateRSVPRecord {
  responderPubkey: string;
  status: RSVPStatusValue;
  comment: string;
  createdAt: number;
}

function viewKeyToHex(value: string): string {
  if (!value) return '';
  if (value.startsWith('nsec1')) {
    const decoded = decodeNip19(value);
    if (decoded.type === 'nsec') return bytesToHex(decoded.data as Uint8Array);
    return '';
  }
  return value;
}

export class CalendarInviteService {
  private static instance: CalendarInviteService | null = null;

  public static getInstance(): CalendarInviteService {
    if (!CalendarInviteService.instance) {
      CalendarInviteService.instance = new CalendarInviteService();
    }
    return CalendarInviteService.instance;
  }

  public static resetInstance(): void {
    CalendarInviteService.instance = null;
  }

  private readonly transport = NostrTransport.getInstance();
  private readonly auth = AuthService.getInstance();
  private destroyed = false;

  /**
   * Fetch received invitation wraps, unwrap them and parse the rumor.
   * Locally dismissed wraps are filtered out.
   */
  public async fetchInvites(): Promise<CalendarInvite[]> {
    const user = this.auth.getCurrentUser();
    if (!user || this.destroyed) return [];

    const relays = await resolveCalendarRelays([user.pubkey]);
    const wraps = await this.transport.fetchDirect(
      relays,
      [
        // Current wraps: NIP-59 kind 1059 with the calendar classifier tag.
        {
          kinds: [1059 as NDKKind],
          '#p': [user.pubkey],
          '#k': ['1052'],
          limit: 100,
        },
        // Legacy Form* wraps (dedicated kind) — read-only migration support.
        {
          kinds: [1052 as NDKKind],
          '#p': [user.pubkey],
          limit: 50,
        },
      ],
      FETCH_TIMEOUT_MS,
      'calendar-invites'
    );

    const dismissed = this.getDismissedWrapIds();
    const dm = ModuleLoader.getInstance().getApi<DMsModuleApi>('dms');
    const invites: CalendarInvite[] = [];

    for (const wrap of wraps) {
      const wrapId = wrap.id ?? '';
      if (!wrapId || dismissed.includes(wrapId)) continue;
      try {
        const rumor = await dm?.unwrapGiftWrapEvent(wrap);
        if (!rumor) continue;
        const invite = this.parseInviteRumor(rumor, wrapId);
        if (invite) invites.push(invite);
      } catch {
        // Not a calendar wrap / undecryptable — skip silently.
      }
    }

    if (invites.length > 0) {
      diagLog('system', 'calendar: invitations received', {
        count: invites.length,
      });
    }
    return invites;
  }

  private parseInviteRumor(
    rumor: NostrEvent,
    wrapId: string
  ): CalendarInvite | null {
    const aTag = rumor.tags.find(tag => tag[0] === 'a')?.[1];
    const viewKeyRaw = rumor.tags.find(tag => tag[0] === 'viewKey')?.[1];
    if (!aTag || !viewKeyRaw) return null;

    const [kindStr, authorPubkey] = aTag.split(':');
    if (!isPrivateEventKind(Number(kindStr)) || !authorPubkey) return null;

    const signingNsecTag = rumor.tags.find(
      tag => tag[0] === 'signing_nsec'
    )?.[1];
    return {
      wrapId,
      coordinate: aTag,
      authorPubkey,
      relayHint: rumor.tags.find(tag => tag[0] === 'a')?.[2] ?? '',
      viewSecretHex: viewKeyToHex(viewKeyRaw),
      message: rumor.content || undefined,
      signingNsec: signingNsecTag,
      createdAt: rumor.created_at,
    };
  }

  /**
   * Accept an invitation into the private calendar and dismiss the wrap.
   */
  public async acceptInvite(invite: CalendarInvite): Promise<void> {
    const { PrivateCalendarService } = await import('./PrivateCalendarService');
    const ref: PrivateEventRef = {
      coordinate: invite.coordinate,
      relayHint: invite.relayHint,
      viewSecretHex: invite.viewSecretHex,
    };
    await PrivateCalendarService.getInstance().importInvite(ref);
    await this.dismiss(invite);
  }

  /**
   * Dismiss an invitation: delete the wrap via its embedded signing key when
   * available, and always record it locally so it never shows again.
   */
  public async dismiss(invite: CalendarInvite): Promise<void> {
    if (invite.signingNsec) {
      try {
        const deletion = {
          kind: 5,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['e', invite.wrapId]],
          content: '',
        };
        const signed = finalizeEventSigning(
          deletion as unknown as Parameters<typeof finalizeEventSigning>[0],
          viewKeyToHex(invite.signingNsec)
        );
        const relays = await resolveCalendarRelays([]);
        await this.transport.publish(relays, signed as unknown as NostrEvent);
      } catch (error) {
        diagLog('system', 'calendar: wrap deletion failed', {
          error: String(error).slice(0, 120),
        });
      }
    }
    this.rememberDismissed(invite.wrapId);
  }

  /**
   * Send gift-wrap invitations for an own private event to participants.
   * Called after the event publish (relayHint = first accepted relay).
   */
  public async sendInvites(
    event: CalendarEventData,
    participants: string[],
    relayHint: string
  ): Promise<number> {
    const user = this.auth.getCurrentUser();
    if (!user || !event.viewSecretHex || participants.length === 0) return 0;
    const dm = ModuleLoader.getInstance().getApi<DMsModuleApi>('dms');
    const { encodeNsec: encodeNsecFn } = await import(
      '../../services/NostrToolsAdapter'
    );

    let sent = 0;
    for (const participant of participants) {
      const rumor = {
        kind: 14,
        pubkey: user.pubkey,
        created_at: Math.floor(Date.now() / 1000),
        content: `You have been invited to an event: ${event.title || '(Untitled event)'}`,
        tags: [
          ['p', participant],
          ['a', event.coordinate, relayHint],
          ['viewKey', encodeNsecFn(event.viewSecretHex)],
        ],
      } as unknown as NostrEvent;
      try {
        const result = await dm?.deliverGiftWrap(rumor, participant, [
          ['k', '1052'],
        ]);
        if (result) sent++;
      } catch {
        // Continue with remaining participants.
      }
    }
    diagLog('system', 'calendar: invitations sent', {
      dTag: event.dTag,
      sent,
      of: participants.length,
    });
    return sent;
  }

  // ---------- private RSVPs (kind 32069) ----------

  /** Publish the current user's RSVP for a private event (view-key encrypted). */
  public async publishPrivateRSVP(
    event: CalendarEventData,
    status: RSVPStatusValue,
    comment = ''
  ): Promise<void> {
    const user = this.auth.getCurrentUser();
    if (!user || !event.viewSecretHex)
      throw new Error('No view key for this event');

    const content = encryptWithViewKey(
      JSON.stringify({ status, comment }),
      event.viewSecretHex
    );
    const unsigned = {
      kind: 32069,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['a', event.coordinate],
        ['d', `${user.pubkey}:${event.pubkey}:${event.dTag}`],
      ],
      content,
      pubkey: user.pubkey,
    };
    const signed = await this.auth.signEvent(unsigned);
    if (!signed) throw new Error('Signing failed');

    await this.transport.publishWithOutbox(signed, {
      authorPubkeys: [user.pubkey, event.pubkey],
    });
    diagLog('system', 'calendar: private rsvp published', { status });
  }

  /**
   * Fetch + decrypt all RSVPs for a private event. Only view-key holders can
   * read the aggregate — mirroring the Form* private RSVP model.
   */
  public async fetchPrivateRSVPs(
    event: CalendarEventData
  ): Promise<PrivateRSVPRecord[]> {
    const user = this.auth.getCurrentUser();
    if (!user || !event.viewSecretHex || this.destroyed) return [];

    const relays = await resolveCalendarRelays([user.pubkey, event.pubkey]);
    const raw = await this.transport.fetchDirect(
      relays,
      [{ kinds: [32069 as NDKKind], '#a': [event.coordinate], limit: 200 }],
      FETCH_TIMEOUT_MS,
      'calendar-private-rsvps'
    );

    // Latest per responder wins (parameterized replaceable).
    const latest = new Map<string, NostrEvent>();
    for (const ev of raw) {
      const prev = latest.get(ev.pubkey);
      if (!prev || ev.created_at > prev.created_at) latest.set(ev.pubkey, ev);
    }

    const records: PrivateRSVPRecord[] = [];
    for (const [pubkey, ev] of latest) {
      const payload = decryptWithViewKey<{
        status?: string;
        comment?: string;
      }>(ev.content, event.viewSecretHex);
      const status = payload?.status;
      if (
        status !== 'accepted' &&
        status !== 'declined' &&
        status !== 'tentative'
      ) {
        continue;
      }
      records.push({
        responderPubkey: pubkey,
        status,
        comment: payload?.comment ?? '',
        createdAt: ev.created_at,
      });
    }
    return records;
  }

  // ---------- dismissed storage ----------

  private getDismissedWrapIds(): string[] {
    return PerAccountLocalStorage.getInstance().get<string[]>(
      StorageKeys.CALENDAR_DISMISSED_INVITES,
      []
    );
  }

  private rememberDismissed(wrapId: string): void {
    const dismissed = this.getDismissedWrapIds();
    if (!dismissed.includes(wrapId)) {
      dismissed.push(wrapId);
      PerAccountLocalStorage.getInstance().set(
        StorageKeys.CALENDAR_DISMISSED_INVITES,
        dismissed
      );
    }
  }

  public destroy(): void {
    this.destroyed = true;
    CalendarInviteService.resetInstance();
  }
}
