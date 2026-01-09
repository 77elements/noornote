/**
 * DMService - NIP-17 Direct Messages Orchestrator
 * Handles Gift Wrap encryption/decryption and subscription management
 *
 * @service DMService
 * @purpose Send and receive NIP-17 encrypted DMs
 * @used-by MessagesView, ConversationView
 *
 * Architecture (from NIP-17 spec):
 * - kind:14 = Chat Message (Rumor, unsigned)
 * - kind:13 = Seal (encrypted rumor, signed by sender)
 * - kind:1059 = Gift Wrap (encrypted seal, signed by ephemeral key)
 * - kind:10050 = DM Relay List (user's preferred DM relays)
 */

import { NDKEvent, NDKPrivateKeySigner } from '@nostr-dev-kit/ndk';
import type { NostrEvent, NDKFilter } from '@nostr-dev-kit/ndk';
import { NostrTransport } from '../transport/NostrTransport';
import { AuthService } from '../AuthService';
import { RelayConfig } from '../RelayConfig';
import { DMStore, type DMMessage, type DMConversation } from './DMStore';
import { EventBus } from '../EventBus';
import { SystemLogger } from '../../components/system/SystemLogger';
import { FollowCheckService } from '../FollowCheckService';
import { MuteOrchestrator } from '../orchestration/MuteOrchestrator';
import { generateSecretKey, getPublicKey, calculateEventHash } from '../../services/NostrToolsAdapter';

// NIP-17 Kind constants
const KIND_PRIVATE_MESSAGE = 14;
const KIND_SEAL = 13;
const KIND_GIFT_WRAP = 1059;
const KIND_DM_RELAY_LIST = 10050;

// NIP-04 Legacy Kind (deprecated but still widely used)
const KIND_LEGACY_DM = 4;

export class DMService {
  private static instance: DMService;
  private transport: NostrTransport;
  private authService: AuthService;
  private relayConfig: RelayConfig;
  private dmStore: DMStore;
  private eventBus: EventBus;
  private systemLogger: SystemLogger;
  private followCheckService: FollowCheckService;
  private muteOrchestrator: MuteOrchestrator;
  private subscriptionId: string | null = null;
  private userPubkey: string | null = null;

  // Cache for muted pubkeys (refreshed on mute:updated event)
  private mutedPubkeys: Set<string> = new Set();
  private mutedPubkeysLoaded: boolean = false;

  // Batch event emitting - collect events during fetch, emit once at end
  private isFetchingHistorical: boolean = false;
  private pendingBadgeUpdate: boolean = false;

  // Progress tracking for UI
  private fetchProgress: { current: number; total: number } = { current: 0, total: 0 };

  private constructor() {
    this.transport = NostrTransport.getInstance();
    this.authService = AuthService.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.dmStore = DMStore.getInstance();
    this.eventBus = EventBus.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.followCheckService = FollowCheckService.getInstance();
    this.muteOrchestrator = MuteOrchestrator.getInstance();

    // Listen for mute updates to refresh cache
    this.eventBus.on('mute:updated', () => {
      this.refreshMutedPubkeys();
    });

    // Listen for logout - close DB connection (do NOT clear data - per-user DBs preserve data)
    this.eventBus.on('user:logout', () => {
      this.stop();
      this.dmStore.close();
    });
  }

  public static getInstance(): DMService {
    if (!DMService.instance) {
      DMService.instance = new DMService();
    }
    return DMService.instance;
  }

  /**
   * Start DM subscription (called on login)
   */
  public async start(): Promise<void> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        this.systemLogger.warn('DMService', 'Cannot start - no user logged in');
        return;
      }

      // Idempotency check - same user already running
      if (this.userPubkey === currentUser.pubkey && this.subscriptionId) {
        this.systemLogger.info('DMService', 'Already started for this user');
        // Still emit events so late subscribers (like MessagesView) get the data
        this.eventBus.emit('dm:fetch-complete');
        this.eventBus.emit('dm:badge-update');
        return;
      }

      // Initialize per-user database (automatically switches if different user)
      await this.dmStore.init(currentUser.pubkey);

      // Set current user pubkey
      this.userPubkey = currentUser.pubkey;

      this.systemLogger.info('DMService', `Starting DM service for ${currentUser.npub.slice(0, 12)}...`);

      // Fetch historical messages first (don't block on errors)
      try {
        await this.fetchHistoricalMessages();
      } catch (fetchError) {
        this.systemLogger.warn('DMService', 'Error fetching historical messages:', fetchError);
      }

      // Start live subscription (don't block on errors)
      try {
        await this.startSubscription();
      } catch (subError) {
        this.systemLogger.warn('DMService', 'Error starting subscription:', subError);
      }

      this.systemLogger.info('DMService', 'DM service started');
    } catch (error) {
      this.systemLogger.error('DMService', 'Failed to start DM service:', error);
      throw error;
    }
  }

  /**
   * Stop DM subscription (called on logout)
   */
  public stop(): void {
    if (this.subscriptionId) {
      this.transport.unsubscribeLive(this.subscriptionId);
      this.subscriptionId = null;
    }

    this.userPubkey = null;
    this.systemLogger.info('DMService', 'DM service stopped');
  }

  /**
   * Get current fetch progress (for UI progress bar)
   */
  public getFetchProgress(): { current: number; total: number; isLoading: boolean } {
    return {
      ...this.fetchProgress,
      isLoading: this.isFetchingHistorical
    };
  }

  /**
   * Fetch historical DMs from relays (NIP-17 + Legacy NIP-04)
   * - NIP-17 from inbox relays
   * - Legacy NIP-04 from read relays (they're on normal relays, not inbox)
   */
  private async fetchHistoricalMessages(): Promise<void> {
    if (!this.userPubkey) return;

    // Enter batch mode - suppress individual events
    this.isFetchingHistorical = true;
    this.pendingBadgeUpdate = false;
    this.fetchProgress = { current: 0, total: 0 };

    try {
      // NIP-17 uses inbox relays
      const inboxRelays = await this.getMyInboxRelays();

      // Fetch NIP-17 Gift Wraps (kind:1059)
      const nip17Filter: NDKFilter = {
        kinds: [KIND_GIFT_WRAP],
        '#p': [this.userPubkey],
        limit: 500
      };

      this.systemLogger.info('DMService', `Fetching NIP-17 DMs from ${inboxRelays.length} inbox relays: ${inboxRelays.slice(0, 3).join(', ')}${inboxRelays.length > 3 ? '...' : ''}`);
      const nip17Events = await this.transport.fetch(inboxRelays, [nip17Filter], 15000);
      this.systemLogger.info('DMService', `Fetched ${nip17Events.length} NIP-17 events`);

      // Legacy NIP-04 uses READ relays (they're on normal relays, not specialized inbox)
      const readRelays = this.relayConfig.getReadRelays();

      const legacyFilters: NDKFilter[] = [
        // Received DMs
        {
          kinds: [KIND_LEGACY_DM],
          '#p': [this.userPubkey],
          limit: 500
        },
        // Sent DMs (our own messages)
        {
          kinds: [KIND_LEGACY_DM],
          authors: [this.userPubkey],
          limit: 500
        }
      ];

      this.systemLogger.info('DMService', `Fetching legacy NIP-04 DMs from ${readRelays.length} read relays: ${readRelays.slice(0, 3).join(', ')}${readRelays.length > 3 ? '...' : ''}`);
      const legacyEvents = await this.transport.fetch(readRelays, legacyFilters, 15000);
      this.systemLogger.info('DMService', `Fetched ${legacyEvents.length} legacy DM events`);

      // Set total for progress tracking
      const totalEvents = nip17Events.length + legacyEvents.length;
      this.fetchProgress.total = totalEvents;

      // Emit initial progress
      this.eventBus.emit('dm:fetch-progress', { current: 0, total: totalEvents });

      // Process all events with unified progress tracking
      const allEvents: Array<{ event: NostrEvent; isNip17: boolean }> = [
        ...nip17Events.map(event => ({ event, isNip17: true })),
        ...legacyEvents.map(event => ({ event, isNip17: false }))
      ];

      for (const { event, isNip17 } of allEvents) {
        if (isNip17) {
          await this.processGiftWrap(event);
        } else {
          await this.processLegacyDM(event);
        }
        this.fetchProgress.current++;
        // Emit progress every 10 events to avoid flooding
        if (this.fetchProgress.current % 10 === 0) {
          this.eventBus.emit('dm:fetch-progress', { ...this.fetchProgress });
        }
      }

    } catch (error) {
      this.systemLogger.error('DMService', 'Failed to fetch historical messages:', error);
    } finally {
      // Exit batch mode - emit single consolidated event
      this.isFetchingHistorical = false;

      // Emit completion
      this.eventBus.emit('dm:fetch-progress', { current: this.fetchProgress.total, total: this.fetchProgress.total });
      this.eventBus.emit('dm:fetch-complete');

      // If any messages were processed, emit a single badge update
      if (this.pendingBadgeUpdate) {
        this.eventBus.emit('dm:badge-update');
        this.pendingBadgeUpdate = false;
      }
    }
  }

  /**
   * Start live subscription for new DMs (NIP-17 + Legacy NIP-04)
   */
  private async startSubscription(): Promise<void> {
    if (!this.userPubkey) return;

    const relays = await this.getMyInboxRelays();
    const now = Math.floor(Date.now() / 1000);

    // Combined filter for NIP-17 and Legacy NIP-04
    const filters: NDKFilter[] = [
      // NIP-17 Gift Wraps
      {
        kinds: [KIND_GIFT_WRAP],
        '#p': [this.userPubkey],
        since: now
      },
      // Legacy NIP-04 received
      {
        kinds: [KIND_LEGACY_DM],
        '#p': [this.userPubkey],
        since: now
      }
    ];

    this.subscriptionId = 'dm-subscription';

    await this.transport.subscribeLive(
      relays,
      filters,
      this.subscriptionId,
      async (event: NostrEvent) => {
        if (event.kind === KIND_GIFT_WRAP) {
          await this.processGiftWrap(event);
        } else if (event.kind === KIND_LEGACY_DM) {
          await this.processLegacyDM(event);
        }
      }
    );

    this.systemLogger.info('DMService', `Live subscription active on ${relays.length} relays`);
  }

  /**
   * Process a gift-wrapped event (unwrap and store)
   */
  private async processGiftWrap(wrapEvent: NostrEvent): Promise<void> {
    try {
      // Check if already processed
      if (await this.dmStore.hasMessage(wrapEvent.id)) {
        return;
      }

      // Unwrap: GiftWrap -> Seal -> Rumor
      const rumor = await this.unwrapGiftWrap(wrapEvent);

      if (!rumor) {
        return;
      }

      // Determine conversation partner
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) return;

      const conversationWith = rumor.pubkey === currentUser.pubkey
        ? this.getRecipientFromTags(rumor.tags) || ''
        : rumor.pubkey;

      if (!conversationWith) {
        this.systemLogger.warn('DMService', 'Could not determine conversation partner');
        return;
      }

      // Extract metadata from tags
      const replyTo = this.getTagValue(rumor.tags, 'e', 'reply');
      const subject = this.getTagValue(rumor.tags, 'subject');

      // Create message record
      const message: DMMessage = {
        id: rumor.id || wrapEvent.id,
        pubkey: rumor.pubkey,
        content: rumor.content,
        createdAt: rumor.created_at,
        conversationWith,
        replyTo,
        subject,
        isMine: rumor.pubkey === currentUser.pubkey,
        wrapId: wrapEvent.id,
        format: 'nip17'
      };

      // Store message
      await this.dmStore.saveMessage(message);

      // Emit events - batch during historical fetch, immediate for live
      if (this.isFetchingHistorical) {
        this.pendingBadgeUpdate = true;
      } else {
        this.eventBus.emit('dm:new-message', { message, conversationWith });
        this.eventBus.emit('dm:badge-update');
      }
    } catch (error) {
      this.systemLogger.error('DMService', 'Error processing gift wrap:', error);
    }
  }

  /**
   * Process a legacy NIP-04 DM (kind:4)
   */
  private async processLegacyDM(event: NostrEvent): Promise<void> {
    try {
      // Check if already processed
      if (await this.dmStore.hasMessage(event.id)) {
        return;
      }

      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) return;

      // Determine if we sent or received this message
      const isMine = event.pubkey === currentUser.pubkey;

      // Get the conversation partner from p-tag
      const pTag = event.tags.find(t => t[0] === 'p');
      if (!pTag) {
        // No p-tag - malformed DM
        return;
      }

      const conversationWith = isMine ? pTag[1] : event.pubkey;

      // Decrypt the content using NIP-04
      let decryptedContent: string;
      try {
        // For received messages, decrypt with sender's pubkey
        // For sent messages, decrypt with recipient's pubkey
        const decryptPubkey = isMine ? pTag[1] : event.pubkey;
        decryptedContent = await this.authService.nip04Decrypt(event.content, decryptPubkey);
      } catch (decryptError) {
        // Decryption failed - could be corrupted or not meant for us
        // Only log during live subscription, not during batch fetch
        if (!this.isFetchingHistorical) {
          this.systemLogger.warn('DMService', `Failed to decrypt legacy DM ${event.id.slice(0, 8)}`);
        }
        return;
      }

      // Create message record
      const message: DMMessage = {
        id: event.id,
        pubkey: event.pubkey,
        content: decryptedContent,
        createdAt: event.created_at,
        conversationWith,
        isMine,
        wrapId: event.id, // Use event ID as wrapId for dedup
        format: 'legacy'
      };

      // Store message
      await this.dmStore.saveMessage(message);

      // Emit events - batch during historical fetch, immediate for live
      if (this.isFetchingHistorical) {
        this.pendingBadgeUpdate = true;
      } else {
        this.eventBus.emit('dm:new-message', { message, conversationWith });
        this.eventBus.emit('dm:badge-update');
      }
    } catch (error) {
      this.systemLogger.error('DMService', 'Error processing legacy DM:', error);
    }
  }

  /**
   * Unwrap a gift-wrapped event to get the rumor
   * Uses AuthService for decryption (works with all signer types)
   */
  private async unwrapGiftWrap(wrapEvent: NostrEvent): Promise<NostrEvent | null> {
    try {
      // Step 1: Decrypt gift wrap content to get seal (kind:13)
      // The wrapper is signed by ephemeral key, content encrypted to recipient
      const sealJson = await this.authService.nip44Decrypt(wrapEvent.content, wrapEvent.pubkey);

      if (!sealJson) {
        return null;
      }

      const seal = JSON.parse(sealJson) as NostrEvent;

      // Verify seal is kind:13
      if (seal.kind !== KIND_SEAL) {
        // Expected for non-NIP-17 events - console only
        console.debug('[DMService] Expected seal (kind:13), got kind:', seal.kind);
        return null;
      }

      // Step 2: Decrypt seal content to get rumor (kind:14)
      // The seal is signed by the actual sender
      const rumorJson = await this.authService.nip44Decrypt(seal.content, seal.pubkey);

      if (!rumorJson) {
        return null;
      }

      const rumor = JSON.parse(rumorJson) as NostrEvent;

      // Verify rumor is kind:14
      if (rumor.kind !== KIND_PRIVATE_MESSAGE) {
        return null;
      }

      // Anti-spoofing: verify rumor.pubkey === seal.pubkey
      if (rumor.pubkey !== seal.pubkey) {
        this.systemLogger.warn('DMService', 'Spoofing detected: rumor.pubkey !== seal.pubkey');
        return null;
      }

      return rumor;
    } catch (error) {
      // Silent fail for console only - decryption errors are expected for non-owned messages
      console.debug('[DMService] Failed to unwrap gift wrap:', error);
      return null;
    }
  }

  /**
   * Send a DM to a recipient
   */
  public async sendMessage(recipientPubkey: string, content: string, replyTo?: string): Promise<boolean> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.systemLogger.error('DMService', 'Cannot send - no user logged in');
      return false;
    }

    try {
      this.systemLogger.info('DMService', `Sending DM to ${recipientPubkey.slice(0, 8)}...`);

      // Step 1: Create rumor (kind:14, UNSIGNED but with calculated id)
      const now = Math.floor(Date.now() / 1000);
      const tags: string[][] = [['p', recipientPubkey]];

      if (replyTo) {
        tags.push(['e', replyTo, '', 'reply']);
      }

      const rumorBase = {
        kind: KIND_PRIVATE_MESSAGE,
        pubkey: currentUser.pubkey,
        created_at: now,
        content,
        tags
      };

      // Calculate id for rumor (NIP-17 requires id but no signature)
      const rumorId = calculateEventHash(rumorBase);
      const rumor: NostrEvent = {
        ...rumorBase,
        id: rumorId,
        sig: '' // No signature for rumor
      };

      // Step 2: Create gift wrap for recipient
      const recipientWrap = await this.createGiftWrap(rumor, recipientPubkey);

      if (!recipientWrap) {
        throw new Error('Failed to create gift wrap for recipient');
      }

      // Step 3: Get recipient's DM relays
      const recipientRelays = await this.getUserInboxRelays(recipientPubkey);

      // Step 4: Publish to recipient's relays
      await this.transport.publish(recipientRelays, recipientWrap);

      this.systemLogger.info('DMService', `Sent to recipient on ${recipientRelays.length} relays`);

      // Step 5: Create and publish self-copy
      const selfWrap = await this.createGiftWrap(rumor, currentUser.pubkey);

      if (selfWrap) {
        const myRelays = await this.getMyInboxRelays();
        await this.transport.publish(myRelays, selfWrap);
        this.systemLogger.info('DMService', 'Self-copy published');
      }

      // Step 6: Store message locally with selfWrap.id as wrapId
      // This ensures that when the self-copy comes back from the relay,
      // hasMessage(selfWrap.id) returns true and it's skipped as duplicate
      const message: DMMessage = {
        id: `local-${Date.now()}`,
        pubkey: currentUser.pubkey,
        content,
        createdAt: now,
        conversationWith: recipientPubkey,
        replyTo,
        isMine: true,
        wrapId: selfWrap?.id || recipientWrap.id,
        format: 'nip17' // We always send NIP-17
      };

      await this.dmStore.saveMessage(message);

      // Emit dm:new-message so ConversationView updates
      this.eventBus.emit('dm:new-message', { message, conversationWith: recipientPubkey });

      return true;
    } catch (error) {
      this.systemLogger.error('DMService', 'Failed to send message:', error);
      return false;
    }
  }

  /**
   * Create a gift-wrapped event
   * Rumor -> Seal -> Gift Wrap
   */
  private async createGiftWrap(rumor: NostrEvent, recipientPubkey: string): Promise<NostrEvent | null> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) return null;

    try {
      // Step 1: Create seal (encrypt rumor, sign with sender's key)
      const rumorJson = JSON.stringify(rumor);
      const encryptedRumor = await this.authService.nip44Encrypt(rumorJson, recipientPubkey);

      const sealTimestamp = this.randomizeTimestamp(Math.floor(Date.now() / 1000));
      const unsignedSeal = {
        kind: KIND_SEAL,
        pubkey: currentUser.pubkey,
        created_at: sealTimestamp,
        content: encryptedRumor,
        tags: [] as string[][] // MUST be empty per NIP-17
      };

      const signedSeal = await this.authService.signEvent(unsignedSeal);

      // Step 2: Create gift wrap (encrypt seal with ephemeral key)
      const ephemeralSecretKey = generateSecretKey();
      const ephemeralPubkey = getPublicKey(ephemeralSecretKey);
      // Convert Uint8Array to hex string (browser-compatible, no Buffer)
      const ephemeralHex = Array.from(ephemeralSecretKey)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
      const ephemeralSigner = new NDKPrivateKeySigner(ephemeralHex);

      const sealJson = JSON.stringify(signedSeal);

      // Create NDK instance for encryption
      const ndk = this.transport.getNDK();
      const recipientUser = ndk.getUser({ pubkey: recipientPubkey });

      // Encrypt seal with ephemeral key -> recipient
      const encryptedSeal = await ephemeralSigner.encrypt(recipientUser, sealJson, 'nip44');

      const wrapTimestamp = this.randomizeTimestamp(Math.floor(Date.now() / 1000));
      const unsignedWrap = {
        kind: KIND_GIFT_WRAP,
        pubkey: ephemeralPubkey,
        created_at: wrapTimestamp,
        content: encryptedSeal,
        tags: [['p', recipientPubkey]]
      };

      // Sign with ephemeral key
      const wrapEvent = new NDKEvent(ndk, unsignedWrap);
      await wrapEvent.sign(ephemeralSigner);

      return wrapEvent.rawEvent();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : '';
      this.systemLogger.error('DMService', `Failed to create gift wrap: ${errorMsg}`);
      console.error('[DMService] Gift wrap error:', error, errorStack);
      return null;
    }
  }

  /**
   * Randomize timestamp (up to 48 hours in the past per NIP-17)
   */
  private randomizeTimestamp(timestamp: number): number {
    const maxOffset = 48 * 60 * 60; // 48 hours in seconds
    const randomOffset = Math.floor(Math.random() * maxOffset);
    return timestamp - randomOffset;
  }

  /**
   * Get current user's inbox relays (from config or fallback)
   * Combines: configured inbox relays + aggregator relays + nostr1.com relays
   */
  private async getMyInboxRelays(): Promise<string[]> {
    const relays = new Set<string>();

    // Add configured inbox relays if available
    const configRelays = this.relayConfig.getInboxRelays();
    configRelays.forEach(r => relays.add(r));

    // Add aggregator relays (popular public relays)
    const aggregatorRelays = this.relayConfig.getAggregatorRelays();
    aggregatorRelays.forEach(r => relays.add(r));

    // Add nostr1.com relays as fallback
    this.FALLBACK_INBOX_RELAYS.forEach(r => relays.add(r));

    return Array.from(relays);
  }

  /**
   * Default fallback inbox relays (nostr1.com infrastructure)
   */
  private readonly FALLBACK_INBOX_RELAYS = [
    'wss://noornode.nostr1.com',
    'wss://bitcoinmajlis.nostr1.com'
  ];

  /**
   * Get a user's inbox relays (kind:10050)
   * Used when SENDING DMs to determine where to publish
   */
  public async getUserInboxRelays(pubkey: string): Promise<string[]> {
    try {
      // For own user: use getMyInboxRelays (which combines all sources)
      if (pubkey === this.userPubkey) {
        return this.getMyInboxRelays();
      }

      // For other users: fetch their kind:10050 from relays
      const relays = this.relayConfig.getReadRelays();
      const filter: NDKFilter = {
        kinds: [KIND_DM_RELAY_LIST],
        authors: [pubkey],
        limit: 1
      };

      const events = await this.transport.fetch(relays, [filter], 5000);

      if (events.length > 0) {
        const dmRelays = events[0].tags
          .filter(t => t[0] === 'relay')
          .map(t => t[1]);

        if (dmRelays.length > 0) {
          this.systemLogger.info('DMService', `Found kind:10050 for ${pubkey.slice(0, 8)} with ${dmRelays.length} DM relays`);
          // Also add aggregator relays to ensure delivery
          const aggregators = this.relayConfig.getAggregatorRelays();
          return [...new Set([...dmRelays, ...aggregators])];
        }
      }

      // Fallback for other users: use aggregator relays
      return this.relayConfig.getAggregatorRelays();
    } catch {
      this.systemLogger.warn('DMService', `Failed to fetch inbox relays for ${pubkey.slice(0, 8)}`);
      return this.relayConfig.getAggregatorRelays();
    }
  }

  /**
   * Get recipient pubkey from p-tags (for determining conversation partner on own messages)
   */
  private getRecipientFromTags(tags: string[][]): string | null {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) return null;

    for (const tag of tags) {
      if (tag[0] === 'p' && tag[1] !== currentUser.pubkey) {
        return tag[1];
      }
    }

    return null;
  }

  /**
   * Get tag value by name and optional marker
   */
  private getTagValue(tags: string[][], name: string, marker?: string): string | undefined {
    for (const tag of tags) {
      if (tag[0] === name) {
        if (marker) {
          // For e-tags with markers (e.g., ['e', 'eventId', 'relay', 'reply'])
          if (tag[3] === marker) {
            return tag[1];
          }
        } else {
          // For simple tags (e.g., ['subject', 'Hello'])
          return tag[1];
        }
      }
    }
    return undefined;
  }

  /**
   * Get total unread count (excludes muted users)
   */
  public async getUnreadCount(): Promise<number> {
    await this.loadMutedPubkeys();

    const conversations = await this.dmStore.getConversations();
    let total = 0;

    for (const conv of conversations) {
      if (!this.isMutedSync(conv.pubkey)) {
        total += conv.unreadCount;
      }
    }

    return total;
  }

  /**
   * Get conversations with pagination
   */
  public async getConversations(limit?: number, offset: number = 0) {
    return this.dmStore.getConversations(limit, offset);
  }

  /**
   * Get messages for a conversation
   */
  public async getMessages(partnerPubkey: string, limit?: number, before?: number) {
    return this.dmStore.getMessages(partnerPubkey, limit, before);
  }

  /**
   * Mark conversation as read
   */
  public async markAsRead(partnerPubkey: string) {
    await this.dmStore.markAsRead(partnerPubkey);
    this.eventBus.emit('dm:badge-update');
  }

  /**
   * Mark all conversations as read
   */
  public async markAllAsRead(): Promise<void> {
    await this.dmStore.markAllAsRead();
    this.eventBus.emit('dm:badge-update');
  }

  /**
   * Mark all conversations as unread
   */
  public async markAllAsUnread(): Promise<void> {
    await this.dmStore.markAllAsUnread();
    this.eventBus.emit('dm:badge-update');
  }

  /**
   * Get unread counts split by known (followed) and unknown users
   * Excludes muted users from counts
   */
  public async getUnreadCountsSplit(): Promise<{ known: number; unknown: number; total: number }> {
    await this.followCheckService.init();
    await this.loadMutedPubkeys();

    const conversations = await this.dmStore.getConversations();
    let known = 0;
    let unknown = 0;

    for (const conv of conversations) {
      // Skip muted users
      if (this.isMutedSync(conv.pubkey)) {
        continue;
      }

      if (conv.unreadCount > 0) {
        if (this.followCheckService.isFollowingSync(conv.pubkey)) {
          known += conv.unreadCount;
        } else {
          unknown += conv.unreadCount;
        }
      }
    }

    return { known, unknown, total: known + unknown };
  }

  /**
   * Get conversations split by known/unknown status
   * Excludes muted users
   * @param filter - 'known' | 'unknown' | 'all'
   */
  public async getConversationsFiltered(
    filter: 'known' | 'unknown' | 'all',
    limit?: number,
    offset: number = 0
  ): Promise<DMConversation[]> {
    await this.followCheckService.init();
    await this.loadMutedPubkeys();

    // Get all conversations first
    const allConversations = await this.dmStore.getConversations();

    // Filter out muted users first, then by known/unknown
    let filtered: DMConversation[];
    if (filter === 'all') {
      filtered = allConversations.filter(c => !this.isMutedSync(c.pubkey));
    } else if (filter === 'known') {
      filtered = allConversations.filter(c =>
        !this.isMutedSync(c.pubkey) && this.followCheckService.isFollowingSync(c.pubkey)
      );
    } else {
      filtered = allConversations.filter(c =>
        !this.isMutedSync(c.pubkey) && !this.followCheckService.isFollowingSync(c.pubkey)
      );
    }

    // Apply offset and limit
    if (offset > 0) {
      filtered = filtered.slice(offset);
    }
    if (limit !== undefined) {
      filtered = filtered.slice(0, limit);
    }

    return filtered;
  }

  /**
   * Check if a pubkey is a known (followed) user
   */
  public async isKnownUser(pubkey: string): Promise<boolean> {
    return this.followCheckService.isFollowing(pubkey);
  }

  /**
   * Clear all DM data (for logout)
   */
  public async clear(): Promise<void> {
    await this.dmStore.clear();
    this.followCheckService.clear();
    this.mutedPubkeys.clear();
    this.mutedPubkeysLoaded = false;
    // Notify UI to update badge (will hide since no user/data)
    this.eventBus.emit('dm:badge-update');
  }

  /**
   * Load muted pubkeys into cache
   */
  private async loadMutedPubkeys(): Promise<void> {
    if (this.mutedPubkeysLoaded) return;

    try {
      const browserItems = this.muteOrchestrator.getBrowserItems();
      this.mutedPubkeys.clear();

      for (const item of browserItems) {
        if (item.type === 'user') {
          this.mutedPubkeys.add(item.id);
        }
      }

      this.mutedPubkeysLoaded = true;
    } catch (error) {
      this.systemLogger.error('DMService', 'Failed to load muted pubkeys:', error);
    }
  }

  /**
   * Refresh muted pubkeys cache (called on mute:updated event)
   */
  private async refreshMutedPubkeys(): Promise<void> {
    this.mutedPubkeysLoaded = false;
    await this.loadMutedPubkeys();
  }

  /**
   * Check if a pubkey is muted (sync, uses cache)
   */
  private isMutedSync(pubkey: string): boolean {
    return this.mutedPubkeys.has(pubkey);
  }
}
