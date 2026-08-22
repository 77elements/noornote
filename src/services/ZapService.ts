/**
 * ZapService - Lightning Zaps via WebLN / NWC (NIP-57)
 * Handles zap requests, LNURL fetching, and invoice payments
 * Payment priority: NWC (if configured in Settings) → WebLN (Keychat browser, Alby, etc.)
 *
 * NIP-57: https://github.com/nostr-protocol/nips/blob/master/57.md
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { generateSecretKey, finalizeEvent } from './NostrToolsAdapter';
import { NWCService, type PayInvoiceResult } from './NWCService';
import { AuthService } from './AuthService';
import { UserProfileService } from './UserProfileService';
import { RelayConfig } from './RelayConfig';
import { NostrTransport } from './transport/NostrTransport';
import { ErrorService } from './ErrorService';
import { ToastService } from './ToastService';
import { SystemLogger } from './SystemLogger';
import { OutboundRelaysOrchestrator } from './orchestration/OutboundRelaysOrchestrator';
import { ProfileOrchestrator } from './orchestration/ProfileOrchestrator';
import { SignatureVerificationService } from './security/SignatureVerificationService';
import { PlatformService } from './PlatformService';
import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';

export interface ZapRequest {
  noteId?: string;
  authorPubkey: string;
  amount: number; // in sats
  comment?: string;
  /**
   * LONG-FORM ARTICLES ONLY: Event ID for addressable events
   * When zapping an article, noteId is the addressable identifier (kind:pubkey:d-tag)
   * and articleEventId is the actual event ID (hex). Both are needed for proper tagging.
   */
  articleEventId?: string;
  /**
   * When true, the kind:9734 zap request is signed with a throwaway ephemeral key
   * and carries an `["anon", ""]` tag — recipient sees the sats but neither relays
   * nor recipient nor any third party can identify the real sender.
   */
  anonymous?: boolean;
}

export interface ZapResult {
  success: boolean;
  error?: string;
  invoice?: string;
  preimage?: string;
  amount?: number; // Amount in sats (for optimistic UI update)
}

interface ProfileWithLightning {
  pubkey: string;
  lud16?: string;
  lud06?: string;
  name?: string;
  display_name?: string;
}

export class ZapService {
  private static instance: ZapService;
  private nwcService: NWCService;
  private authService: AuthService;
  private userProfileService: UserProfileService;
  private relayConfig: RelayConfig;
  private nostrTransport: NostrTransport;
  private systemLogger: SystemLogger;
  private outboundRelaysFetcher: OutboundRelaysOrchestrator;

  private constructor() {
    this.nwcService = NWCService.getInstance();
    this.authService = AuthService.getInstance();
    this.userProfileService = UserProfileService.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.nostrTransport = NostrTransport.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.outboundRelaysFetcher = OutboundRelaysOrchestrator.getInstance();
  }

  public static getInstance(): ZapService {
    if (!ZapService.instance) {
      ZapService.instance = new ZapService();
    }
    return ZapService.instance;
  }

  /**
   * Check if noteId is a long-form article (addressable event)
   * Format: "kind:pubkey:d-tag" (e.g., "30023:abc123...:my-article")
   * Normal notes are just hex event IDs without colons
   */
  private isLongFormArticle(noteId: string): boolean {
    return noteId.includes(':');
  }

  /**
   * Fetch with timeout wrapper
   */
  private async fetchWithTimeout(
    url: string,
    timeoutMs: number = 10000
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Fetch timeout (${timeoutMs / 1000}s)`);
      }
      throw error;
    }
  }

  /**
   * Try to enable WebLN provider (Keychat browser, Alby extension, etc.)
   * Only available in browser environment (Web version), never in Electron desktop app.
   */
  private async tryEnableWebLN(): Promise<boolean> {
    try {
      if (!PlatformService.getInstance().isBrowser) return false;
      if (!window.webln) return false;
      await window.webln.enable();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Pay Lightning invoice via WebLN provider
   *
   * Handles two response formats:
   * - Keychat: returns raw preimage string, errors start with "Error:"
   * - Standard WebLN (Alby, etc.): returns { preimage: string }
   */
  private async payWithWebLN(invoice: string): Promise<PayInvoiceResult> {
    try {
      const result = await window.webln!.sendPayment(invoice);

      // Keychat returns preimage as raw string, errors start with "Error:"
      if (typeof result === 'string') {
        if (result.startsWith('Error:')) {
          return { success: false, error: result };
        }
        return { success: true, preimage: result };
      }

      // Standard WebLN returns { preimage: string }
      if (result && typeof result === 'object' && 'preimage' in result) {
        return {
          success: true,
          preimage: (result as { preimage: string }).preimage,
        };
      }

      return { success: false, error: 'Unexpected WebLN response' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'WebLN payment failed',
      };
    }
  }

  /**
   * Check if any payment method is available (NWC or WebLN)
   * NWC takes priority (user explicitly configured it in Settings).
   * WebLN is only used when no NWC is configured (e.g., Keychat browser).
   */
  private async checkPaymentAvailability(): Promise<ZapResult | null> {
    if (this.nwcService.isConnected()) return null;
    if (await this.tryEnableWebLN()) return null;

    ToastService.show('Please connect Lightning Wallet', 'error');
    return { success: false, error: 'No payment method available' };
  }

  /**
   * Send quick zap with default amount and comment from settings
   */
  public async sendQuickZap(
    noteId: string,
    authorPubkey: string,
    articleEventId?: string
  ): Promise<ZapResult> {
    const connectionError = await this.checkPaymentAvailability();
    if (connectionError) return connectionError;

    const defaults = await this.getZapDefaults();

    const zapRequest: ZapRequest = {
      noteId,
      authorPubkey,
      amount: defaults.amount,
      comment: defaults.comment,
    };
    if (articleEventId) zapRequest.articleEventId = articleEventId;

    return this.sendZap(zapRequest);
  }

  /**
   * Send custom zap with specified amount and comment
   */
  public async sendCustomZap(
    noteId: string | undefined,
    authorPubkey: string,
    amount: number,
    comment?: string,
    articleEventId?: string,
    anonymous?: boolean
  ): Promise<ZapResult> {
    const connectionError = await this.checkPaymentAvailability();
    if (connectionError) return connectionError;

    const zapRequest: ZapRequest = { authorPubkey, amount };
    if (noteId) zapRequest.noteId = noteId;
    if (comment) zapRequest.comment = comment;
    if (articleEventId) zapRequest.articleEventId = articleEventId;
    if (anonymous) zapRequest.anonymous = true;

    return this.sendZap(zapRequest);
  }

  /** Debounce guard: prevent double-zaps from rapid taps */
  private lastZapTime = 0;
  private static readonly ZAP_DEBOUNCE_MS = 3000;

  /**
   * Core zap flow: Create zap request → Fetch invoice → Pay with NWC → Verify receipt
   * Includes 45-second timeout for entire operation (15s for receipt verification)
   */
  private async sendZap(request: ZapRequest): Promise<ZapResult> {
    const now = Date.now();
    if (now - this.lastZapTime < ZapService.ZAP_DEBOUNCE_MS) {
      return { success: false, error: 'Zap already in progress' };
    }
    this.lastZapTime = now;

    try {
      // Wrap entire zap flow in 45-second timeout (payment + 15s receipt verification)
      const zapPromise = this.executeZapFlow(request);
      const timeoutPromise = new Promise<ZapResult>((_, reject) => {
        setTimeout(
          () => reject(new Error('Zap timeout after 45 seconds')),
          45000
        );
      });

      return await Promise.race([zapPromise, timeoutPromise]);
    } catch (error) {
      this.systemLogger.error('ZapService', 'Zap flow failed', error);

      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      const isTimeout = errorMessage.includes('timeout');

      ToastService.show(
        isTimeout ? 'Zap timeout - please try again' : 'Could not zap note',
        'error'
      );

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Execute zap flow without timeout wrapper
   */
  private async executeZapFlow(request: ZapRequest): Promise<ZapResult> {
    // Step 1: Get LNURL from author's profile
    const lnurl = await this.getLNURLFromProfile(request.authorPubkey);
    if (!lnurl) {
      ToastService.show('User cannot receive zaps', 'error');
      return { success: false, error: 'No LNURL found in profile' };
    }

    // Step 2: Create zap request event (kind 9734)
    const zapRequestEvent = await this.createZapRequestEvent(request, lnurl);
    if (!zapRequestEvent) {
      ToastService.show('Failed to create zap request', 'error');
      return { success: false, error: 'Failed to create zap request event' };
    }

    // Step 3: Fetch invoice from LNURL callback
    const invoice = await this.fetchInvoice(
      lnurl,
      zapRequestEvent,
      request.amount
    );
    if (!invoice) {
      ToastService.show('Failed to fetch invoice', 'error');
      return { success: false, error: 'Failed to fetch invoice' };
    }

    this.systemLogger.info('ZapService', 'Invoice received');

    // Record own anonymous-zap bolt11 BEFORE payment so ZapsList can identify
    // it as ours when the receipt later shows up. The bolt11 is the only stable
    // link between the throwaway-signed 9734 and its 9735 receipt — the
    // ephemeral pubkey has been discarded by now.
    if (request.anonymous) {
      this.markOwnAnonZapInvoice(invoice);
    }

    // Step 4: Pay invoice (NWC if configured, otherwise WebLN)
    const useNWC = this.nwcService.isConnected();
    const paymentResult = useNWC
      ? await this.nwcService.payInvoice(invoice)
      : await this.payWithWebLN(invoice);

    if (!useNWC) {
      this.systemLogger.info('ZapService', 'Paying via WebLN');
    }

    if (!paymentResult.success) {
      this.systemLogger.error(
        'ZapService',
        'Payment failed',
        paymentResult.error
      );
      ToastService.show('Payment failed', 'error');
      return {
        success: false,
        error: paymentResult.error || 'Payment failed',
      };
    }

    this.systemLogger.info('ZapService', 'Payment successful');

    // Store zap locally for consistent UI (optimistic update)
    if (request.noteId) {
      this.storeUserZap(request.noteId, request.amount);
    }

    // Show success immediately (UX like Jumble - don't wait for receipt)
    ToastService.show(`${request.amount} sats zapped`, 'success');

    // Step 5: Verify zap receipt in background (don't await - let stats update naturally)
    this.waitForZapReceipt(invoice, request.authorPubkey).then(verified => {
      if (verified) {
        this.systemLogger.info('ZapService', 'Zap receipt verified on relays');
      } else {
        this.systemLogger.warn(
          'ZapService',
          'Zap receipt not found on relays (payment was successful though)'
        );
      }
    });

    const result: ZapResult = {
      success: true,
      invoice,
      amount: request.amount,
    };
    if (paymentResult.preimage) result.preimage = paymentResult.preimage;
    return result;
  }

  /**
   * Get LNURL callback from user profile
   * Returns the callback URL needed to request invoice
   * FALLBACK: If lud16/lud06 missing, fetch profile from user's outbound relays
   */
  private async getLNURLFromProfile(pubkey: string): Promise<string | null> {
    try {
      // Step 1: Try to get profile from standard relays
      const profile = await this.userProfileService.getUserProfile(pubkey);

      // Step 2: Check if profile exists AND has lud16/lud06 (nip05 as fallback)
      let lightningProfile: ProfileWithLightning | null = null;
      if (profile) {
        lightningProfile = { pubkey: profile.pubkey };
        if (profile.lud16) lightningProfile.lud16 = profile.lud16;
        else if (
          !profile.lud06 &&
          profile.nip05 &&
          profile.nip05.includes('@')
        ) {
          lightningProfile.lud16 = profile.nip05;
        }
        if (profile.lud06) lightningProfile.lud06 = profile.lud06;
        if (profile.name) lightningProfile.name = profile.name;
        if (profile.display_name)
          lightningProfile.display_name = profile.display_name;
      }

      if (
        !lightningProfile ||
        (!lightningProfile.lud16 && !lightningProfile.lud06)
      ) {
        this.systemLogger.info(
          'ZapService',
          "No profile or lud16/lud06 found in standard relays, trying user's outbound relays..."
        );

        // FALLBACK: Fetch profile from user's outbound relays
        lightningProfile = await this.fetchProfileFromUserRelays(pubkey);

        if (
          !lightningProfile ||
          (!lightningProfile.lud16 && !lightningProfile.lud06)
        ) {
          this.systemLogger.warn(
            'ZapService',
            "No lud16/lud06 found in user's relays either"
          );
          return null;
        }

        this.systemLogger.info(
          'ZapService',
          `Found lud16/lud06 in user's relays: ${lightningProfile.lud16 || lightningProfile.lud06}`
        );
      } else {
        this.systemLogger.info(
          'ZapService',
          `Profile found in standard relays: lud16=${lightningProfile.lud16}, lud06=${lightningProfile.lud06}`
        );
      }

      // Step 3: Get zap endpoint (callback + lnurl)
      const zapOptions: { lud16?: string; lud06?: string } = {};
      if (lightningProfile.lud16) zapOptions.lud16 = lightningProfile.lud16;
      if (lightningProfile.lud06) zapOptions.lud06 = lightningProfile.lud06;
      const zapEndpoint = await this.getZapEndpoint(zapOptions);

      if (!zapEndpoint) {
        this.systemLogger.warn('ZapService', 'No valid zap endpoint found');
        return null;
      }

      // Return the callback URL
      return zapEndpoint.callback;
    } catch (error) {
      this.systemLogger.error(
        'ZapService',
        'Failed to get LNURL from profile',
        error
      );
      return null;
    }
  }

  /**
   * FALLBACK: Fetch profile from user's outbound relays (Kind 10002 → Kind 0)
   * Only called when lud16/lud06 is missing from standard relay profile
   */
  private async fetchProfileFromUserRelays(
    pubkey: string
  ): Promise<ProfileWithLightning | null> {
    try {
      // Step 1: Fetch user's outbound relays (Kind 10002)
      const userRelays = await this.outboundRelaysFetcher.discoverUserRelays([
        pubkey,
      ]);
      const firstRelay = userRelays[0];

      if (!firstRelay || firstRelay.writeRelays.length === 0) {
        this.systemLogger.warn(
          'ZapService',
          'No outbound relays found for user'
        );
        return null;
      }

      this.systemLogger.info(
        'ZapService',
        `Found ${firstRelay.writeRelays.length} outbound relays`
      );

      // Step 2: Fetch kind:0 from the author's write relays via the sanctioned
      // orchestrator path (hints-first fetch; dedup + timeouts handled there).
      // This replaces a hand-rolled raw subscription whose 100ms polling
      // interval leaked on timeout and blocked the zap flow for a fixed 5s.
      const profile = await ProfileOrchestrator.getInstance().fetchProfile(
        pubkey,
        firstRelay.writeRelays
      );
      if (!profile) {
        this.systemLogger.warn(
          'ZapService',
          "No profile found in user's relays"
        );
        return null;
      }

      this.systemLogger.info(
        'ZapService',
        `Profile fetched from user's relays`
      );

      const lightning: ProfileWithLightning = { pubkey };
      const lud16 =
        profile.lud16 ||
        (!profile.lud06 && profile.nip05?.includes('@')
          ? profile.nip05
          : undefined);
      if (lud16) lightning.lud16 = lud16;
      if (profile.lud06) lightning.lud06 = profile.lud06;
      if (profile.name) lightning.name = profile.name;
      if (profile.display_name) lightning.display_name = profile.display_name;
      return lightning;
    } catch (error) {
      this.systemLogger.error(
        'ZapService',
        'Failed to fetch profile from user relays',
        error
      );
      return null;
    }
  }

  /**
   * Get zap endpoint (callback + lnurl) from profile
   * Implements NIP-57 LNURL-pay protocol
   */
  private async getZapEndpoint(profile: {
    lud16?: string;
    lud06?: string;
  }): Promise<{ callback: string; lnurl: string } | null> {
    try {
      let lnurl = '';

      // Try lud16 (Lightning Address) first
      if (profile.lud16 && profile.lud16.includes('@')) {
        const [name, domain] = profile.lud16.split('@');
        if (!name || !domain) {
          this.systemLogger.warn(
            'ZapService',
            'Invalid lud16 format',
            profile.lud16
          );
          return null;
        }
        lnurl = new URL(
          `/.well-known/lnurlp/${name}`,
          `https://${domain}`
        ).toString();
      }
      // lud06 (legacy LNURL) not supported - modern wallets use lud16
      else if (profile.lud06) {
        this.systemLogger.warn(
          'ZapService',
          'lud06 not supported, use lud16 (Lightning Address)'
        );
        return null;
      } else {
        this.systemLogger.warn('ZapService', 'No lud16 or lud06 in profile');
        return null;
      }

      // Fetch LNURL pay request
      const res = await this.fetchWithTimeout(lnurl);

      if (!res.ok) {
        throw new Error(`LNURL fetch failed: ${res.status}`);
      }

      const body = await res.json();

      // CRITICAL: Check for Nostr support (NIP-57 requirement)
      if (body.allowsNostr && body.nostrPubkey) {
        return { callback: body.callback, lnurl };
      }

      this.systemLogger.warn(
        'ZapService',
        'LNURL does not support Nostr zaps (allowsNostr or nostrPubkey missing)'
      );
      return null;
    } catch (error) {
      this.systemLogger.error(
        'ZapService',
        'Failed to get zap endpoint',
        error
      );
      return null;
    }
  }

  /**
   * Create zap request event (kind 9734)
   *
   * NORMAL NOTES: Uses #e tag with event ID
   * LONG-FORM ARTICLES: Uses #a tag with addressable identifier AND #e tag with event ID
   */
  private async createZapRequestEvent(
    request: ZapRequest,
    lnurl: string
  ): Promise<NostrEvent | null> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        this.systemLogger.error('ZapService', 'No user logged in');
        return null;
      }

      // NIP-57: single `relays` tag with multiple values (not multiple separate tags),
      // capped at 4 to match NDK / nostr-tools and stay within typical LNURL-server limits.
      // The `lnurl` tag is mandatory per NIP-57.
      const relays = this.relayConfig.getWriteRelays().slice(0, 4);

      const tags: string[][] = [
        ['p', request.authorPubkey],
        ['amount', (request.amount * 1000).toString()],
        ['relays', ...relays],
        ['lnurl', lnurl],
      ];

      if (request.noteId) {
        const isArticle = this.isLongFormArticle(request.noteId);

        if (isArticle) {
          // LONG-FORM ARTICLE: Use #a tag with addressable identifier
          tags.push(['a', request.noteId]);
          // Also add #e tag with event ID if provided (for better discoverability)
          if (request.articleEventId) {
            tags.push(['e', request.articleEventId]);
          }
          this.systemLogger.info(
            'ZapService',
            `Creating zap request for article: #a=${request.noteId}, #e=${request.articleEventId || 'none'}`
          );
        } else {
          // NORMAL NOTE: Use #e tag with event ID
          tags.push(['e', request.noteId]);
        }
      }
      // else: PROFILE ZAP — only #p tag, no #e/#a (NIP-57)

      // ANONYMOUS branch: throwaway ephemeral key, ["anon", ""] tag.
      // The logged-in signer is bypassed entirely — neither NIP-46 bunker nor
      // NIP-55 Amber sees the event, so the signer cannot log "user zapped X".
      // ephPriv goes out of scope on return and is GC-eligible.
      if (request.anonymous) {
        tags.push(['anon', '']);

        const ephPriv = generateSecretKey();
        // finalizeEvent derives the pubkey internally from ephPriv — we just
        // need to keep ephPriv alive for that one call, then let it fall out
        // of scope so it's GC-eligible. Nothing else may reference it.
        const anonEvent = finalizeEvent(
          {
            kind: 9734,
            created_at: Math.floor(Date.now() / 1000),
            tags,
            content: request.comment || '',
          },
          ephPriv
        );

        // Do NOT log the ephemeral pubkey or event id — that would give a
        // filesystem-access attacker a correlation path despite the anon signature.
        this.systemLogger.info('ZapService', 'Anonymous zap request created');

        return anonEvent as unknown as NostrEvent;
      }

      const unsignedEvent = {
        kind: 9734,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: request.comment || '',
        pubkey: currentUser.pubkey,
      };

      // Sign event
      return this.authService.signEvent(unsignedEvent);
    } catch (error) {
      this.systemLogger.error(
        'ZapService',
        'Failed to create zap request event',
        error
      );
      ErrorService.handle(
        error,
        'ZapService.createZapRequestEvent',
        true,
        'Fehler beim Erstellen der Zap-Anfrage'
      );
      return null;
    }
  }

  /**
   * Fetch Lightning invoice from LNURL callback
   */
  private async fetchInvoice(
    lnurl: string,
    zapRequestEvent: NostrEvent,
    amountSats: number
  ): Promise<string | null> {
    try {
      const amountMillisats = amountSats * 1000;
      const nostrParam = encodeURIComponent(JSON.stringify(zapRequestEvent));
      const separator = lnurl.includes('?') ? '&' : '?';
      const callbackUrl = `${lnurl}${separator}amount=${amountMillisats}&nostr=${nostrParam}`;

      const response = await this.fetchWithTimeout(callbackUrl);

      if (!response.ok) {
        throw new Error(`LNURL server error: ${response.status}`);
      }

      const data = await response.json();

      if (data.status === 'ERROR') {
        throw new Error(data.reason || 'LNURL server returned error');
      }

      if (!data.pr) {
        throw new Error('No invoice (pr) in LNURL response');
      }

      return data.pr;
    } catch {
      return null;
    }
  }

  /**
   * Wait for zap receipt (kind 9735) on relays after payment
   * Verifies that LNURL server published the zap receipt
   * Note: This is background verification - payment success is already confirmed
   */
  private async waitForZapReceipt(
    invoice: string,
    recipientPubkey: string
  ): Promise<boolean> {
    return new Promise(async resolve => {
      try {
        const relays = this.relayConfig.getReadRelays();

        // Subscribe to zap receipts (kind 9735) for recipient in last minute
        const oneMinuteAgo = Math.floor(Date.now() / 1000) - 60;

        this.systemLogger.info(
          'ZapService',
          `Subscribing to zap receipts for ${recipientPubkey.slice(0, 8)}...`
        );

        const verificationService = SignatureVerificationService.getInstance();

        const sub = await this.nostrTransport.subscribe(
          relays,
          [
            {
              kinds: [9735], // Zap receipt
              '#p': [recipientPubkey], // Recipient pubkey
              since: oneMinuteAgo,
            },
          ],
          {
            onEvent: (event: NostrEvent) => {
              const eventId = event.id;
              if (!eventId) return;

              // Security: Verify signature before processing (external source)
              const verification = verificationService.verifyEvent(event);
              if (!verification.valid) {
                this.systemLogger.warn(
                  'ZapService',
                  `Rejected invalid zap receipt ${eventId.slice(0, 8)}: ${verification.error}`
                );
                return;
              }

              this.systemLogger.info(
                'ZapService',
                `Received zap receipt event ${eventId.slice(0, 8)}`
              );
              // Extract bolt11 invoice from zap receipt
              const boltTag = event.tags.find(tag => tag[0] === 'bolt11');
              if (boltTag && boltTag[1] === invoice) {
                this.systemLogger.info('ZapService', 'Zap receipt found');
                sub.close();
                resolve(true);
              }
            },
            onEose: () => {
              this.systemLogger.info(
                'ZapService',
                'EOSE received, zap receipts loaded'
              );
            },
          }
        );

        // Timeout after 15 seconds (LNURL server should publish receipt quickly)
        setTimeout(() => {
          this.systemLogger.warn('ZapService', 'Zap receipt timeout (15s)');
          sub.close();
          resolve(false);
        }, 15000);
      } catch (error) {
        this.systemLogger.error(
          'ZapService',
          'Failed to subscribe to zap receipts',
          error
        );
        resolve(false);
      }
    });
  }

  /**
   * Get zap defaults from localStorage
   */
  private async getZapDefaults(): Promise<{ amount: number; comment: string }> {
    try {
      const { KeychainStorage } = await import('./KeychainStorage');
      const stored = await KeychainStorage.loadZapDefaults();
      if (stored) {
        return stored;
      }
    } catch (error) {
      this.systemLogger.warn(
        'ZapService',
        'Failed to load zap defaults',
        error
      );
    }

    // Default values
    return {
      amount: 21,
      comment: '',
    };
  }

  /**
   * Store user's zap in localStorage for optimistic UI
   * Format: zap_{userPubkey}_{noteId} = amount (in sats)
   */
  private storeUserZap(noteId: string, amount: number): void {
    const zaps = PerAccountLocalStorage.getInstance().get<
      Record<string, number>
    >(StorageKeys.USER_ZAPS, {});
    zaps[noteId] = amount;
    PerAccountLocalStorage.getInstance().set(StorageKeys.USER_ZAPS, zaps);
    this.systemLogger.info(
      'ZapService',
      `Stored zap: ${amount} sats for note ${noteId.slice(0, 8)}`
    );
  }

  /** Cap on the per-account ring buffer of own anonymous-zap invoices. */
  private static readonly OWN_ANON_ZAP_CAP = 500;

  /**
   * Remember a bolt11 invoice we just paid as an anonymous zap.
   * ZapsList consults this to render our own anon-zaps with our own avatar +
   * a lock badge, while still showing them as Anonymous to other viewers
   * (their localStorage doesn't have this entry).
   */
  private markOwnAnonZapInvoice(invoice: string): void {
    const store = PerAccountLocalStorage.getInstance();
    const list = store.get<string[]>(StorageKeys.OWN_ANON_ZAP_INVOICES, []);
    if (list.includes(invoice)) return;
    list.push(invoice);
    while (list.length > ZapService.OWN_ANON_ZAP_CAP) list.shift();
    store.set(StorageKeys.OWN_ANON_ZAP_INVOICES, list);
  }

  /**
   * Check whether a bolt11 invoice belongs to an anonymous zap we sent ourselves.
   * Used by ZapsList to badge our own anonymous zaps in our own UI without
   * leaking that information to other viewers.
   */
  public isOwnAnonZapInvoice(invoice: string): boolean {
    const list = PerAccountLocalStorage.getInstance().get<string[]>(
      StorageKeys.OWN_ANON_ZAP_INVOICES,
      []
    );
    return list.includes(invoice);
  }

  /**
   * Get user's zap amount for a note
   * Returns 0 if user has not zapped this note
   */
  public getUserZapAmount(noteId: string): number {
    const zaps = PerAccountLocalStorage.getInstance().get<
      Record<string, number>
    >(StorageKeys.USER_ZAPS, {});
    return zaps[noteId] || 0;
  }

  /**
   * Check if user has zapped a note (from localStorage)
   */
  public hasUserZapped(noteId: string): boolean {
    return this.getUserZapAmount(noteId) > 0;
  }
}
