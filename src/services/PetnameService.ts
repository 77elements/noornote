/**
 * PetnameService — NIP-02-style petnames stored encrypted via NIP-78 (kind:30078).
 *
 * Local cache in PerAccountLocalStorage for fast reads. Encrypted relay
 * persistence (NIP-44, self-encrypted) for cross-device sync.
 * d-tag: "noornote-petnames".
 */

import { Nip78EncryptedListService } from './Nip78EncryptedListService';
import { StorageKeys } from './PerAccountLocalStorage';
import { diagLog } from './DiagnosticLogger';

export class PetnameService extends Nip78EncryptedListService {
  private static instance: PetnameService | null = null;

  // In-memory mirror of the PETNAMES map so per-note lookups (avatar rings)
  // never trigger a JSON.parse per call. Keyed to the owning pubkey so an
  // account switch can never serve another account's petnames.
  private cachedMap: Record<string, string> | null = null;
  private cachedOwnerPubkey: string | null = null;

  protected get dTag(): string {
    return 'noornote-petnames';
  }

  protected get logTag(): string {
    return 'PetnameSvc';
  }

  protected override get diagTag(): string {
    return 'PetnameService';
  }

  private constructor() {
    super();
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

    const map = await this.fetchEncryptedMap();
    if (!map) return;

    this.pals.set(StorageKeys.PETNAMES, map as Record<string, string>);
    this.cachedMap = map as Record<string, string>;
    this.cachedOwnerPubkey = user.pubkey;
    diagLog('system', 'PetnameService synced from relays', {
      count: Object.keys(map).length,
    });
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
    await this.publishEncryptedMap(map, 'Failed to save petname');
  }
}
