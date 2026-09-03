/**
 * Nip78EncryptedListService — shared base for services that persist a
 * per-account Record as a NIP-44 self-encrypted NIP-78 event (kind:30078):
 * petnames (noornote-petnames), soft mutes (noornote:soft-mutes), …
 *
 * Owns the shared machinery extracted from PetnameService and
 * SoftMuteService:
 *   - fetch + NIP-44 decrypt + JSON-parse of the newest kind:30078 event
 *     for the service's d-tag (outbox relays via getCombinedRelays)
 *   - NIP-44 encrypt + sign + publishContent of the map
 *   - diagLog bookkeeping with the service's log tag
 *
 * Subclasses own their local cache shape, merge/replace semantics and
 * extra fields (debounce, feature flags, …).
 */

import { AuthService } from './AuthService';
import { NostrTransport } from './transport/NostrTransport';
import { OutboundRelaysOrchestrator } from './orchestration/OutboundRelaysOrchestrator';
import { PerAccountLocalStorage } from './PerAccountLocalStorage';
import { ToastService } from './ToastService';
import { diagLog } from './DiagnosticLogger';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

const NIP78_KIND = 30078;

export abstract class Nip78EncryptedListService {
  protected auth: AuthService;
  protected transport: NostrTransport;
  protected pals: PerAccountLocalStorage;

  protected constructor() {
    this.auth = AuthService.getInstance();
    this.transport = NostrTransport.getInstance();
    this.pals = PerAccountLocalStorage.getInstance();
  }

  /** NIP-78 d-tag identifying this list (e.g. "noornote-petnames"). */
  protected abstract get dTag(): string;

  /** Log tag for transport fetch labels (e.g. "PetnameSvc"). */
  protected abstract get logTag(): string;

  /** Diag-log prefix — keep byte-identical with the pre-refactor messages. */
  protected get diagTag(): string {
    return this.logTag;
  }

  /**
   * Fetch + decrypt the newest relay event for this list. Returns the parsed
   * map, or null when the user is logged out, no event exists, decryption or
   * parsing failed (all conditions are logged, never thrown).
   */
  protected async fetchEncryptedMap(): Promise<Record<string, unknown> | null> {
    const user = this.auth.getCurrentUser();
    if (!user) return null;

    try {
      const relays =
        await OutboundRelaysOrchestrator.getInstance().getCombinedRelays(
          [user.pubkey],
          true
        );
      if (relays.length === 0) return null;

      const events: NostrEvent[] = await this.transport.fetch(
        relays,
        [
          {
            kinds: [NIP78_KIND as number],
            authors: [user.pubkey],
            '#d': [this.dTag],
            limit: 1,
          },
        ],
        5000,
        false,
        this.logTag
      );

      if (events.length === 0) return null;

      const event = events.sort((a, b) => b.created_at - a.created_at)[0];
      if (!event?.content) return null;

      const plaintext = await this.auth.nip44Decrypt(
        event.content,
        user.pubkey
      );
      const map = JSON.parse(plaintext) as Record<string, unknown>;
      if (typeof map !== 'object' || map === null) return null;
      return map;
    } catch (error) {
      diagLog('system', `${this.diagTag} sync failed`, {
        error: String(error),
      });
      return null;
    }
  }

  /**
   * Encrypt (NIP-44) and publish the map as this service's kind:30078 event.
   * Failures are logged + toasted, never thrown.
   */
  protected async publishEncryptedMap(
    map: Record<string, unknown>,
    failToast: string
  ): Promise<void> {
    const user = this.auth.getCurrentUser();
    if (!user) return;

    try {
      const plaintext = JSON.stringify(map);
      const encrypted = await this.auth.nip44Encrypt(plaintext, user.pubkey);

      const unsigned = {
        kind: NIP78_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['d', this.dTag]],
        content: encrypted,
        pubkey: user.pubkey,
      };

      const signed = await this.auth.signEvent(unsigned);
      if (!signed) {
        ToastService.show('Signing failed', 'error');
        return;
      }

      await this.transport.publishContent(signed);
      diagLog('system', `${this.diagTag} published to relays`, {
        count: Object.keys(map).length,
      });
    } catch (error) {
      diagLog('system', `${this.diagTag} publish failed`, {
        error: String(error),
      });
      ToastService.show(failToast, 'error');
    }
  }
}
