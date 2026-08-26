/**
 * PetnameService — NIP-02-style petnames stored encrypted via NIP-78 (kind:30078).
 *
 * Local cache in PerAccountLocalStorage for fast reads. Encrypted relay
 * persistence (NIP-44, self-encrypted) for cross-device sync.
 * d-tag: "noornote-petnames".
 */

import { AuthService } from './AuthService';
import { NostrTransport } from './transport/NostrTransport';
import { OutboundRelaysOrchestrator } from './orchestration/OutboundRelaysOrchestrator';
import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';
import { ToastService } from './ToastService';
import { diagLog } from './DiagnosticLogger';

const NIP78_KIND = 30078;
const D_TAG = 'noornote-petnames';

export class PetnameService {
  private static instance: PetnameService | null = null;
  private auth: AuthService;
  private transport: NostrTransport;
  private pals: PerAccountLocalStorage;

  // In-memory mirror of the PETNAMES map so per-note lookups (avatar rings)
  // never trigger a JSON.parse per call. Keyed to the owning pubkey so an
  // account switch can never serve another account's petnames.
  private cachedMap: Record<string, string> | null = null;
  private cachedOwnerPubkey: string | null = null;

  private constructor() {
    this.auth = AuthService.getInstance();
    this.transport = NostrTransport.getInstance();
    this.pals = PerAccountLocalStorage.getInstance();
  }

  public static getInstance(): PetnameService {
    if (!PetnameService.instance) {
      PetnameService.instance = new PetnameService();
    }
    return PetnameService.instance;
  }

  public destroy(): void {
    this.cachedMap = null;
    this.cachedOwnerPubkey = null;
    PetnameService.instance = null;
  }

  /**
   * Whether the "Private petnames" feature is enabled (Privacy Settings).
   * When on, profiles show a note icon for these encrypted, self-only notes.
   * Default off — existing entries stay safe on relays but hidden until opted in.
   */
  public isPrivateNotesEnabled(): boolean {
    return this.pals.get<boolean>(StorageKeys.PRIVATE_PETNAMES_ENABLED, false);
  }

  public setPrivateNotesEnabled(enabled: boolean): void {
    this.pals.set(StorageKeys.PRIVATE_PETNAMES_ENABLED, enabled);
  }

  public getPetname(pubkey: string): string | null {
    return this.getMap()[pubkey] ?? null;
  }

  /**
   * True when the feature is enabled AND this pubkey has a private note.
   * Drives the warning-orange avatar ring in UserIdentity.
   */
  public hasPrivateNote(pubkey: string): boolean {
    return this.isPrivateNotesEnabled() && this.getMap()[pubkey] !== undefined;
  }

  public async setPetname(pubkey: string, petname: string): Promise<void> {
    const map = this.getMap();
    if (petname) {
      map[pubkey] = petname;
    } else {
      delete map[pubkey];
    }
    this.pals.set(StorageKeys.PETNAMES, map);
    await this.publishToRelays(map);
  }

  /**
   * Fetch petnames from relays and populate local cache.
   * Called on login / account switch.
   */
  public async syncFromRelays(): Promise<void> {
    const user = this.auth.getCurrentUser();
    if (!user) return;

    try {
      const relays =
        await OutboundRelaysOrchestrator.getInstance().getCombinedRelays(
          [user.pubkey],
          true
        );
      if (relays.length === 0) return;

      const events = await this.transport.fetch(
        relays,
        [
          {
            kinds: [NIP78_KIND as number],
            authors: [user.pubkey],
            '#d': [D_TAG],
            limit: 1,
          },
        ],
        5000,
        false,
        'PetnameSvc'
      );

      if (events.length === 0) return;

      const event = events.sort((a, b) => b.created_at - a.created_at)[0];
      if (!event?.content) return;

      const plaintext = await this.auth.nip44Decrypt(
        event.content,
        user.pubkey
      );
      const map = JSON.parse(plaintext) as Record<string, string>;
      if (typeof map === 'object' && map !== null) {
        this.pals.set(StorageKeys.PETNAMES, map);
        this.cachedMap = map;
        this.cachedOwnerPubkey = user.pubkey;
        diagLog('system', 'PetnameService synced from relays', {
          count: Object.keys(map).length,
        });
      }
    } catch (error) {
      diagLog('system', 'PetnameService sync failed', { error: String(error) });
    }
  }

  /**
   * Load the petname map (once per account) and keep it cached. Mutations go
   * through setPetname, which mutates this same object and persists it, so
   * the cache never goes stale between reads.
   */
  private getMap(): Record<string, string> {
    const owner = this.auth.getCurrentUser()?.pubkey ?? null;
    if (this.cachedMap === null || this.cachedOwnerPubkey !== owner) {
      this.cachedMap =
        this.pals.get<Record<string, string>>(StorageKeys.PETNAMES, {}) ?? {};
      this.cachedOwnerPubkey = owner;
    }
    return this.cachedMap;
  }

  private async publishToRelays(map: Record<string, string>): Promise<void> {
    const user = this.auth.getCurrentUser();
    if (!user) return;

    try {
      const plaintext = JSON.stringify(map);
      const encrypted = await this.auth.nip44Encrypt(plaintext, user.pubkey);

      const unsigned = {
        kind: NIP78_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['d', D_TAG]],
        content: encrypted,
        pubkey: user.pubkey,
      };

      const signed = await this.auth.signEvent(unsigned);
      if (!signed) {
        ToastService.show('Signing failed', 'error');
        return;
      }

      await this.transport.publishContent(signed);
      diagLog('system', 'PetnameService published to relays', {
        count: Object.keys(map).length,
      });
    } catch (error) {
      diagLog('system', 'PetnameService publish failed', {
        error: String(error),
      });
      ToastService.show('Failed to save petname', 'error');
    }
  }
}
