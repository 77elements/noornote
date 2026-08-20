/**
 * UserStatusService — NIP-38 user statuses (kind 30315, d=general).
 *
 * A one-line "what am I doing right now" status shown on the profile.
 * Addressable + replaceable per status type; we only handle `general`.
 * - Read: latest kind 30315 with d=general from the author; expired
 *   (`expiration` tag, NIP-40) or empty content means "no status".
 * - Write: publish a new event (replaces the old one). Empty content clears.
 *
 * Fetch relays = own read relays + the profile owner's outbound (NIP-65),
 * same strategy as ProfileCarouselOrchestrator. Cached per pubkey with
 * in-flight dedupe so repeated PV renders share one fetch.
 */

import { NostrTransport } from './transport/NostrTransport';
import { OutboundRelaysOrchestrator } from './orchestration/OutboundRelaysOrchestrator';
import { RelayConfig } from './RelayConfig';
import { AuthService } from './AuthService';
import { AuthGuard } from './AuthGuard';
import { ToastService } from './ToastService';
import { diagLog } from './DiagnosticLogger';
import { LRUCache, getCacheSize } from '../helpers/LRUCache';

const NIP38_KIND = 30315;
const STATUS_TYPE = 'general';

export class UserStatusService {
  private static instance: UserStatusService | null = null;
  private transport: NostrTransport;
  private relayDiscovery: OutboundRelaysOrchestrator;
  private relayConfig: RelayConfig;
  private auth: AuthService;

  /** Cache TTL: 5 minutes (a status changes rarely; PV re-renders are frequent) */
  private readonly CACHE_TTL = 5 * 60 * 1000;
  private cache = new LRUCache<string | null>(getCacheSize(50, 30, 20), this.CACHE_TTL);
  private inFlight = new Map<string, Promise<string | null>>();

  private constructor() {
    this.transport = NostrTransport.getInstance();
    this.relayDiscovery = OutboundRelaysOrchestrator.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.auth = AuthService.getInstance();
  }

  public static getInstance(): UserStatusService {
    if (!UserStatusService.instance) {
      UserStatusService.instance = new UserStatusService();
    }
    return UserStatusService.instance;
  }

  public destroy(): void {
    this.cache.clear();
    this.inFlight.clear();
    UserStatusService.instance = null;
  }

  /**
   * Latest general status of a pubkey, or null when none/expired/cleared.
   * Cached; concurrent callers share one fetch.
   */
  public async getStatus(pubkey: string): Promise<string | null> {
    const cached = this.cache.get(pubkey);
    if (cached !== undefined) return cached;

    const inflight = this.inFlight.get(pubkey);
    if (inflight) return inflight;

    const promise = this.doFetchStatus(pubkey);
    this.inFlight.set(pubkey, promise);
    try {
      const result = await promise;
      this.cache.set(pubkey, result);
      return result;
    } finally {
      this.inFlight.delete(pubkey);
    }
  }

  /**
   * Publish the current user's general status. Empty string clears the status
   * (NIP-38: empty content = client should clear).
   * Optimistic: the local cache is updated immediately so the UI can render
   * the new status while the relay publish is still in flight; on failure the
   * previous value is restored and callers get false to revert their UI.
   */
  public async setStatus(text: string): Promise<boolean> {
    if (!AuthGuard.requireAuth('set your status')) return false;
    const user = this.auth.getCurrentUser();
    if (!user) return false;

    const content = text.trim();
    const previous = this.cache.get(user.pubkey) ?? null;
    this.cache.set(user.pubkey, content || null);
    try {
      const unsigned = {
        kind: NIP38_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['d', STATUS_TYPE]],
        content,
        pubkey: user.pubkey,
      };

      const signed = await this.auth.signEvent(unsigned);
      if (!signed) {
        this.cache.set(user.pubkey, previous);
        ToastService.show('Signing failed', 'error');
        return false;
      }

      await this.transport.publishContent(signed);
      diagLog('system', 'UserStatusService published status', { cleared: !content });
      return true;
    } catch (error) {
      this.cache.set(user.pubkey, previous);
      diagLog('system', 'UserStatusService publish failed', { error: String(error) });
      ToastService.show('Failed to save status', 'error');
      return false;
    }
  }

  private async doFetchStatus(pubkey: string): Promise<string | null> {
    const baseRelays: string[] = [
      ...this.relayConfig.getReadRelays(),
      ...this.relayConfig.getAggregatorRelays(),
    ];
    let relays = baseRelays;
    try {
      const outbound = await this.relayDiscovery.getCombinedRelays([pubkey], true);
      relays = [...new Set([...baseRelays, ...outbound])];
    } catch { /* base relays only */ }

    try {
      const events = await this.transport.fetch(relays, [{
        kinds: [NIP38_KIND as number],
        authors: [pubkey],
        '#d': [STATUS_TYPE],
        limit: 2,
      }], 5000, false, 'UserStatusSvc');

      const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
      if (!latest) return null;

      // NIP-40: an expired status must be treated as gone (relays MAY delete,
      // not MUST). Non-numeric / missing = no expiry.
      const expiration = latest.tags?.find((tag: string[]) => tag[0] === 'expiration')?.[1];
      if (expiration && Number(expiration) * 1000 <= Date.now()) return null;

      const content = latest.content?.trim();
      return content || null;
    } catch {
      return null;
    }
  }
}
