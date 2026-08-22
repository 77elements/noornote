/**
 * DMStore - IndexedDB Storage for NIP-17 Direct Messages
 * Stores unwrapped rumors (kind:14) and conversation metadata
 *
 * @service DMStore
 * @purpose Persistent storage for DM conversations and messages
 * @used-by DMService
 */

import { SystemLogger } from '../SystemLogger';
import { diagLog } from '../DiagnosticLogger';
import { PerAccountLocalStorage, StorageKeys } from '../PerAccountLocalStorage';

export type DMFormat = 'nip17' | 'legacy';

export interface DMMessage {
  /** Event ID of the rumor (kind:14) */
  id: string;
  /** Sender pubkey (hex) */
  pubkey: string;
  /** Message content */
  content: string;
  /** Real timestamp (from rumor, not gift wrap) */
  createdAt: number;
  /** Conversation partner pubkey (hex) - for indexing */
  conversationWith: string;
  /** Reply-to event ID (from e-tag with 'reply' marker) */
  replyTo?: string;
  /** Subject/title of conversation (from 'subject' tag) */
  subject?: string;
  /** Whether this message was sent by current user */
  isMine: boolean;
  /** Gift wrap event ID (for deduplication) */
  wrapId: string;
  /** Message format: 'nip17' (secure) or 'legacy' (NIP-04) */
  format: DMFormat;
  /**
   * Wall-clock unix seconds at which this message should disappear locally
   * (computed from rumor.created_at + duration from the expiration tag, see
   * DMExpiration.computeExpiresAt). Undefined = never expires.
   */
  expiresAt?: number;
}

export interface DMConversation {
  /** Partner pubkey (hex) - primary key */
  pubkey: string;
  /** Last message timestamp */
  lastMessageAt: number;
  /** Last message preview (truncated) */
  lastMessagePreview: string;
  /** Unread message count */
  unreadCount: number;
  /** Timestamp when conversation was last marked as read (for persistence) */
  lastReadAt: number;
  /** Conversation subject (latest) */
  subject?: string;
  /** Locally soft-deleted: hidden from lists, messages up to deletedAt filtered out */
  deleted?: boolean;
  /** Soft-delete cutoff (seconds). A newer message resurrects the conversation. */
  deletedAt?: number;
  /**
   * Per-conversation disappearing-messages setting (NIP-17 + NIP-40).
   *   undefined = undecided (no commitment yet)
   *   0         = off (do not tag outgoing, do not sweep)
   *   >0        = seconds; outgoing messages get an `expiration` tag.
   * Mirrored to PerAccountLocalStorage (DM_DISAPPEARING_SETTINGS) to survive
   * IndexedDB eviction (same rationale as read anchors).
   *
   * Doubles as the "currently accepted peer duration" for incoming tagged
   * messages: any incoming message whose duration != this value is held in
   * the store but hidden from the conversation view until the user accepts
   * the new duration (which sets this field to that value).
   */
  disappearingSeconds?: number | undefined;
  /**
   * The peer duration we last prompted the user about (whether they said Yes
   * or No). Used for change detection: only re-prompt when the peer's latest
   * duration DIFFERS from this. After Yes, this equals `disappearingSeconds`.
   * After No, this equals the rejected duration but `disappearingSeconds`
   * keeps its previous value — so the same duration won't re-prompt until
   * the peer changes again.
   */
  lastPromptedPeerDuration?: number;
}

const DB_NAME_PREFIX = 'noornote_dm_';
// v5 → v6: re-issue of the expiresAt index. The original v4→v5 upgrade path
// silently failed to create the index on some installs (either the upgrade
// transaction was blocked by a stale connection, or the ELSE branch hit an
// untracked error). v6 forces a fresh upgrade attempt; the missing index is
// re-created below.
const DB_VERSION = 6;
const MESSAGES_STORE = 'messages';
const CONVERSATIONS_STORE = 'conversations';

export class DMStore {
  private static instance: DMStore;
  private db: IDBDatabase | null = null;
  private systemLogger: SystemLogger;
  private initPromise: Promise<void> | null = null;
  private currentUserPubkey: string | null = null;
  /**
   * In-memory { partnerPubkey → lastReadAt } read-anchor map, mirrored to
   * PerAccountLocalStorage (which survives WebView IndexedDB eviction). Loaded
   * on init; consulted by saveMessage as a fallback when the conversation
   * record is missing (wiped/fresh DB) so a re-synced history doesn't re-count
   * already-read messages as unread. See docs/todos/indexeddb-eviction-nwc-dm.md.
   */
  private readAnchorMirror: Map<string, number> = new Map();
  /**
   * In-memory { partnerPubkey → disappearingSeconds } mirror. Same eviction-
   * survival rationale as readAnchorMirror: if IndexedDB is wiped, the per-conv
   * setting rehydrates from localStorage so outgoing messages stay tagged.
   * Value semantics match DMConversation.disappearingSeconds.
   */
  private disappearingMirror: Map<string, number | undefined> = new Map();

  private constructor() {
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): DMStore {
    if (!DMStore.instance) {
      DMStore.instance = new DMStore();
    }
    return DMStore.instance;
  }

  /**
   * Initialize IndexedDB for a specific user (per-user database)
   * @param userPubkey The user's pubkey to create/open database for
   */
  public async init(userPubkey?: string): Promise<void> {
    // If pubkey provided and different from current, close existing DB and reinit
    if (userPubkey && this.currentUserPubkey !== userPubkey) {
      if (this.db) {
        this.db.close();
        this.db = null;
      }
      this.initPromise = null;
      this.currentUserPubkey = userPubkey;
    }

    // If no pubkey provided and we have a current one, use it
    const pubkey = userPubkey || this.currentUserPubkey;
    if (!pubkey) {
      this.systemLogger.warn(
        'DMStore',
        'init() called without pubkey and no current user'
      );
      return;
    }

    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    const dbName = DB_NAME_PREFIX + pubkey;

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, DB_VERSION);

      request.onerror = () => {
        this.systemLogger.error(
          'DMStore',
          'Failed to open IndexedDB:',
          request.error
        );
        reject(request.error);
      };

      request.onblocked = () => {
        // Another tab/connection is holding the DB at an older version and
        // didn't close in response to our version-change request. The upgrade
        // will fire as soon as that connection closes; meanwhile this open()
        // stays pending. Most common cause: dev-time HMR leaves a stale
        // DMService connection alive. Closing the other tab (or reloading)
        // resolves it.
        diagLog('dms', 'upgrade_blocked', { dbName });
        this.systemLogger.warn(
          'DMStore',
          'IndexedDB upgrade blocked — close other tabs / reload to apply schema change'
        );
      };

      request.onsuccess = () => {
        this.db = request.result;
        this.systemLogger.info(
          'DMStore',
          `IndexedDB initialized for user ${pubkey.slice(0, 8)}...`
        );
        // Load the read-anchor mirror from localStorage BEFORE any message is
        // processed. If the IndexedDB was evicted, the conversation records are
        // gone but this mirror survived — saveMessage falls back to it so reads
        // stay read. Synchronous localStorage read, keyed by this exact pubkey.
        this.loadReadAnchorMirror(pubkey);
        // Same eviction-survival rationale for the disappearing-messages setting.
        this.loadDisappearingMirror(pubkey);
        // Defensive: ensure the expiresAt index actually exists. Earlier
        // v4→v5 upgrades silently failed to create it on some installs; the
        // version bump to v6 should have re-created it via onupgradeneeded,
        // but if for any reason it's still missing, force a fresh upgrade
        // attempt right now.
        this.ensureExpiresAtIndex();
        resolve();
        // Self-heal: if the mirror is empty (fresh install, localStorage cleared,
        // or this feature was added after data already existed), rebuild it from
        // the IndexedDB conversation records so the first re-sync doesn't
        // re-count every old DM as unread. Fire-and-forget — this.db is already
        // set so rebuildAnchorMirrorFromDB's init() call returns immediately.
        if (this.readAnchorMirror.size === 0) {
          this.rebuildAnchorMirrorFromDB().catch(() => {});
        }
      };

      request.onupgradeneeded = event => {
        const req = event.target as IDBOpenDBRequest;
        const db = req.result;
        const upgradeTx = req.transaction!; // set during upgrade

        // Messages store with indexes
        if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
          // Fresh DB → create store with all indexes including expiresAt.
          const messagesStore = db.createObjectStore(MESSAGES_STORE, {
            keyPath: 'id',
          });
          messagesStore.createIndex('conversationWith', 'conversationWith', {
            unique: false,
          });
          messagesStore.createIndex('createdAt', 'createdAt', {
            unique: false,
          });
          messagesStore.createIndex('wrapId', 'wrapId', { unique: true });
          messagesStore.createIndex('expiresAt', 'expiresAt', {
            unique: false,
          });
        } else {
          // Existing store (v4 or v5 upgrade path) → ensure expiresAt index.
          // Wrapped in try/catch because createIndex on an already-existing
          // index throws, and we want the rest of the upgrade to still run.
          try {
            const messagesStore = upgradeTx.objectStore(MESSAGES_STORE);
            if (!messagesStore.indexNames.contains('expiresAt')) {
              messagesStore.createIndex('expiresAt', 'expiresAt', {
                unique: false,
              });
              diagLog('dms', 'expiresAt_index_created_during_upgrade', {
                version: db.version,
              });
            }
          } catch (idxErr) {
            diagLog('dms', 'expiresAt_index_create_failed', {
              error: String(idxErr),
            });
          }
        }

        // Conversations store
        if (!db.objectStoreNames.contains(CONVERSATIONS_STORE)) {
          const conversationsStore = db.createObjectStore(CONVERSATIONS_STORE, {
            keyPath: 'pubkey',
          });
          conversationsStore.createIndex('lastMessageAt', 'lastMessageAt', {
            unique: false,
          });
        }
        // Note: DMConversation.disappearingSeconds is additive — no index needed,
        // existing records just gain an undefined field which our helpers treat
        // as "undecided". Reads go through getDisappearing() which falls back to
        // the localStorage mirror when the field is missing.

        this.systemLogger.info('DMStore', 'IndexedDB schema created/upgraded');
      };
    });

    return this.initPromise;
  }

  /**
   * Get stored user pubkey (for compatibility - returns current user)
   * @deprecated Use init(pubkey) instead
   */
  public async getStoredUserPubkey(): Promise<string | null> {
    return this.currentUserPubkey;
  }

  /**
   * Set stored user pubkey (for compatibility - triggers DB switch)
   * @deprecated Use init(pubkey) instead
   */
  public async setStoredUserPubkey(pubkey: string): Promise<void> {
    if (this.currentUserPubkey !== pubkey) {
      await this.init(pubkey);
    }
  }

  /**
   * Save a message (upsert)
   * Only increments unread count for messages newer than lastReadAt
   */
  public async saveMessage(message: DMMessage): Promise<void> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(
        [MESSAGES_STORE, CONVERSATIONS_STORE],
        'readwrite'
      );
      const messagesStore = tx.objectStore(MESSAGES_STORE);
      const conversationsStore = tx.objectStore(CONVERSATIONS_STORE);

      let mirrorUpdated = false;

      // Check for duplicate by wrapId
      const wrapIndex = messagesStore.index('wrapId');
      const checkRequest = wrapIndex.get(message.wrapId);

      checkRequest.onsuccess = () => {
        if (checkRequest.result) {
          // Already exists, skip
          resolve();
          return;
        }

        // Save message
        messagesStore.put(message);

        // Update conversation
        const getConvRequest = conversationsStore.get(message.conversationWith);
        getConvRequest.onsuccess = () => {
          const existing = getConvRequest.result as DMConversation | undefined;
          const isNewer =
            !existing || message.createdAt > existing.lastMessageAt;

          // Soft-delete handling: a message newer than the delete cutoff
          // resurrects the conversation; an older one (e.g. re-synced history)
          // keeps it hidden and does NOT bump unread.
          const wasDeleted = existing?.deleted === true;
          const resurrect =
            wasDeleted && message.createdAt > (existing?.deletedAt || 0);
          const staysDeleted = wasDeleted && !resurrect;

          // Only count as unread if:
          // 1. Not my own message
          // 2. Message is newer than lastReadAt (or no lastReadAt exists = 0)
          // 3. The conversation isn't staying soft-deleted
          // Read anchor: prefer the live conversation record; if it's missing
          // (evicted/fresh DB), fall back to the localStorage-mirrored anchor so
          // re-synced history isn't re-counted as unread.
          const lastReadAt = existing
            ? existing.lastReadAt
            : (this.readAnchorMirror.get(message.conversationWith) ?? 0);
          const shouldIncrementUnread =
            !message.isMine && message.createdAt > lastReadAt && !staysDeleted;

          // Diagnostic: any time unread is bumped, record whether we knew the conversation and what
          // its read-anchor was. The false-"unread" bug shows up here as a burst with hadConversation
          // true but lastReadAt 0 (known chat that was never marked read → re-counted every re-sync),
          // or hadConversation false (conversation record lost). Live new DMs also log here, but with
          // a real lastReadAt. Makes the mechanism observable instead of guessed.
          if (shouldIncrementUnread) {
            diagLog('dms', 'DM unread bumped', {
              hadConversation: !!existing,
              createdAt: message.createdAt,
              lastReadAt,
              prevUnread: existing?.unreadCount || 0,
            });
          }

          const subject = message.subject || existing?.subject;
          const conversation: DMConversation = {
            pubkey: message.conversationWith,
            lastMessageAt: isNewer
              ? message.createdAt
              : existing!.lastMessageAt,
            lastMessagePreview: isNewer
              ? message.content.slice(0, 100)
              : existing!.lastMessagePreview,
            unreadCount: shouldIncrementUnread
              ? (existing?.unreadCount || 0) + 1
              : existing?.unreadCount || 0,
            lastReadAt,
            ...(subject && { subject }),
            // Keep hidden only while staying deleted; resurrection/new convo clears it.
            ...(staysDeleted && {
              deleted: true,
              deletedAt: existing!.deletedAt,
            }),
          };

          conversationsStore.put(conversation);

          // Keep the read-anchor mirror warm: if this conversation has a
          // lastReadAt higher than what's currently mirrored, update it so
          // a future IndexedDB eviction doesn't lose the read state.
          if (
            lastReadAt > 0 &&
            lastReadAt >
              (this.readAnchorMirror.get(message.conversationWith) ?? 0)
          ) {
            this.readAnchorMirror.set(message.conversationWith, lastReadAt);
            mirrorUpdated = true;
          }
        };
      };

      tx.oncomplete = () => {
        if (mirrorUpdated) this.saveReadAnchorMirror();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Get messages for a conversation (paginated)
   */
  public async getMessages(
    partnerPubkey: string,
    limit: number = 50,
    before?: number
  ): Promise<DMMessage[]> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(
        [MESSAGES_STORE, CONVERSATIONS_STORE],
        'readonly'
      );

      // Look up the soft-delete cutoff first, so messages up to deletedAt stay hidden.
      const convRequest = tx
        .objectStore(CONVERSATIONS_STORE)
        .get(partnerPubkey);
      convRequest.onsuccess = () => {
        const conv = convRequest.result as DMConversation | undefined;
        const deletedAt = conv?.deletedAt || 0;

        const index = tx.objectStore(MESSAGES_STORE).index('conversationWith');
        const request = index.getAll(IDBKeyRange.only(partnerPubkey));

        request.onsuccess = () => {
          let result = request.result as DMMessage[];

          // Filter out messages from before a local soft-delete
          if (deletedAt) {
            result = result.filter(m => m.createdAt > deletedAt);
          }

          // Apply before filter if specified
          if (before) {
            result = result.filter(m => m.createdAt < before);
          }

          // Sort by createdAt ascending (oldest first for display)
          result = result.sort((a, b) => a.createdAt - b.createdAt);

          // Apply limit (take newest)
          if (result.length > limit) {
            result = result.slice(-limit);
          }

          resolve(result);
        };

        request.onerror = () => reject(request.error);
      };

      convRequest.onerror = () => reject(convRequest.error);
    });
  }

  /**
   * Get conversations with pagination (sorted by lastMessageAt desc)
   */
  public async getConversations(
    limit?: number,
    offset: number = 0
  ): Promise<DMConversation[]> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(CONVERSATIONS_STORE, 'readonly');
      const store = tx.objectStore(CONVERSATIONS_STORE);
      const index = store.index('lastMessageAt');
      const conversations: DMConversation[] = [];
      let skipped = 0;

      const request = index.openCursor(null, 'prev');

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(conversations);
          return;
        }

        // Skip locally soft-deleted conversations entirely (not counted toward offset)
        if ((cursor.value as DMConversation).deleted === true) {
          cursor.continue();
          return;
        }

        // Skip items until we reach offset
        if (skipped < offset) {
          skipped++;
          cursor.continue();
          return;
        }

        // Check limit
        if (limit !== undefined && conversations.length >= limit) {
          resolve(conversations);
          return;
        }

        conversations.push(cursor.value as DMConversation);
        cursor.continue();
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get single conversation by partner pubkey
   */
  public async getConversation(
    partnerPubkey: string
  ): Promise<DMConversation | null> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(CONVERSATIONS_STORE, 'readonly');
      const store = tx.objectStore(CONVERSATIONS_STORE);
      const request = store.get(partnerPubkey);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Mark conversation as read (reset unread count and set lastReadAt)
   */
  public async markAsRead(partnerPubkey: string): Promise<void> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(CONVERSATIONS_STORE, 'readwrite');
      const store = tx.objectStore(CONVERSATIONS_STORE);
      const request = store.get(partnerPubkey);

      request.onsuccess = () => {
        const conversation = request.result as DMConversation | undefined;
        if (conversation) {
          conversation.unreadCount = 0;
          conversation.lastReadAt = Math.floor(Date.now() / 1000);
          store.put(conversation);
          // Mirror the new anchor so it survives an IndexedDB eviction.
          this.readAnchorMirror.set(partnerPubkey, conversation.lastReadAt);
          this.saveReadAnchorMirror();
        }
        resolve();
      };

      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Load the { partnerPubkey → lastReadAt } mirror from localStorage into memory
   * for the given user. Called on init, before any message is processed.
   */
  private loadReadAnchorMirror(pubkey: string): void {
    try {
      const obj = PerAccountLocalStorage.getInstance().getForPubkey<
        Record<string, number>
      >(StorageKeys.DM_READ_ANCHORS, pubkey, {});
      this.readAnchorMirror = new Map(Object.entries(obj));
      diagLog('dms', 'read_anchor_mirror_loaded', {
        count: this.readAnchorMirror.size,
      });
    } catch (error) {
      this.readAnchorMirror = new Map();
      diagLog('dms', 'read_anchor_mirror_load_failed', {
        error: String(error),
      });
    }
  }

  /**
   * Persist the current in-memory read-anchor map to localStorage. Only non-zero
   * anchors are stored (a 0 anchor means "unread", i.e. no recovery needed).
   */
  private saveReadAnchorMirror(): void {
    if (!this.currentUserPubkey) return;
    try {
      const obj: Record<string, number> = {};
      for (const [pk, ts] of this.readAnchorMirror) {
        if (ts > 0) obj[pk] = ts;
      }
      PerAccountLocalStorage.getInstance().setForPubkey(
        StorageKeys.DM_READ_ANCHORS,
        this.currentUserPubkey,
        obj
      );
    } catch (error) {
      diagLog('dms', 'read_anchor_mirror_save_failed', {
        error: String(error),
      });
    }
  }

  /**
   * Rebuild the read-anchor mirror from the current conversation records and
   * persist it. Used after bulk mark-all operations so the mirror stays in sync.
   */
  private async rebuildAnchorMirrorFromDB(): Promise<void> {
    await this.init();
    if (!this.db) return;
    const all = await new Promise<DMConversation[]>((resolve, reject) => {
      const tx = this.db!.transaction(CONVERSATIONS_STORE, 'readonly');
      const req = tx.objectStore(CONVERSATIONS_STORE).getAll();
      req.onsuccess = () => resolve((req.result as DMConversation[]) || []);
      req.onerror = () => reject(req.error);
    });
    this.readAnchorMirror = new Map(
      all.map(c => [c.pubkey, c.lastReadAt] as const)
    );
    this.saveReadAnchorMirror();
  }

  /**
   * Defensive check: ensure the `expiresAt` index exists on the messages
   * store. If a previous upgrade was silently blocked or hit an error, the
   * index could be missing even though the DB version was bumped. In that
   * case, close this connection and reopen at version+1 — the upgrade
   * transaction will then recreate the index. Idempotent: no-op if the index
   * is present. Safe to call after every successful open().
   */
  private ensureExpiresAtIndex(): void {
    if (!this.db) return;
    if (!this.db.objectStoreNames.contains(MESSAGES_STORE)) return;

    let indexMissing = false;
    try {
      const tx = this.db.transaction(MESSAGES_STORE, 'readonly');
      const store = tx.objectStore(MESSAGES_STORE);
      indexMissing = !store.indexNames.contains('expiresAt');
    } catch (err) {
      diagLog('dms', 'ensureExpiresAtIndex_probe_failed', {
        error: String(err),
      });
      return; // Don't risk a recursive reopen if the probe itself failed.
    }

    if (!indexMissing) return;

    const currentVersion = this.db.version;
    diagLog('dms', 'expiresAt_index_missing_force_reopen', { currentVersion });
    this.systemLogger.warn(
      'DMStore',
      `expiresAt index missing despite DB v${currentVersion} — forcing reopen at v${currentVersion + 1}`
    );
    // Close the current connection so the version-change request isn't blocked
    // by our own stale handle. The reopen happens via init() which nulls
    // initPromise; the next caller awaits a fresh open().
    this.db.close();
    this.db = null;
    this.initPromise = null;
    // Bump the requested version. DB_VERSION stays constant in code; the
    // override here is just for this recovery path.
    void this.initWithVersion(currentVersion + 1).catch(err => {
      diagLog('dms', 'expiresAt_force_reopen_failed', { error: String(err) });
    });
  }

  /**
   * Open the DB at a specific version (used by ensureExpiresAtIndex for the
   * recovery path). Public surface stays on init(); this is internal-only.
   */
  private async initWithVersion(targetVersion: number): Promise<void> {
    if (!this.currentUserPubkey) return;
    const dbName = DB_NAME_PREFIX + this.currentUserPubkey;
    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, targetVersion);
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        diagLog('dms', 'force_reopen_blocked', { targetVersion });
      };
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
      request.onupgradeneeded = event => {
        const req = event.target as IDBOpenDBRequest;
        const upgradeTx = req.transaction!;
        try {
          const messagesStore = upgradeTx.objectStore(MESSAGES_STORE);
          if (!messagesStore.indexNames.contains('expiresAt')) {
            messagesStore.createIndex('expiresAt', 'expiresAt', {
              unique: false,
            });
            diagLog('dms', 'expiresAt_index_created_via_force_reopen', {
              version: targetVersion,
            });
          }
        } catch (err) {
          diagLog('dms', 'expiresAt_index_force_reopen_failed', {
            error: String(err),
          });
        }
      };
    });
    return this.initPromise;
  }

  /**
   * Soft-delete a conversation: hide it from lists and filter out its messages
   * up to the deletion time. A newer message (via saveMessage) resurrects it.
   * Messages stay in the store (dedup) but are filtered on read.
   */
  public async softDeleteConversation(partnerPubkey: string): Promise<void> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(CONVERSATIONS_STORE, 'readwrite');
      const store = tx.objectStore(CONVERSATIONS_STORE);
      const request = store.get(partnerPubkey);

      request.onsuccess = () => {
        const conversation = request.result as DMConversation | undefined;
        if (conversation) {
          conversation.deleted = true;
          conversation.deletedAt = Math.floor(Date.now() / 1000);
          conversation.unreadCount = 0;
          store.put(conversation);
        }
        resolve();
      };

      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Hard-delete a conversation and all its messages (no resurrection).
   * Used for the "delete & mute" path where the sender is also muted.
   */
  public async purgeConversation(partnerPubkey: string): Promise<void> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(
        [MESSAGES_STORE, CONVERSATIONS_STORE],
        'readwrite'
      );
      tx.objectStore(CONVERSATIONS_STORE).delete(partnerPubkey);

      // Delete every message in this conversation via the conversationWith index
      const index = tx.objectStore(MESSAGES_STORE).index('conversationWith');
      const cursorReq = index.openCursor(IDBKeyRange.only(partnerPubkey));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Mark all conversations as read
   */
  public async markAllAsRead(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.updateAllConversations(
      c => c.unreadCount > 0,
      c => {
        c.unreadCount = 0;
        c.lastReadAt = now;
      }
    );
    await this.rebuildAnchorMirrorFromDB();
  }

  /**
   * Mark all conversations as unread (set unread count to 1)
   */
  public async markAllAsUnread(): Promise<void> {
    await this.updateAllConversations(
      c => c.unreadCount === 0,
      c => {
        c.unreadCount = 1;
        c.lastReadAt = 0;
      }
    );
    await this.rebuildAnchorMirrorFromDB();
  }

  /**
   * Helper to update all conversations matching a condition
   */
  private async updateAllConversations(
    shouldUpdate: (conversation: DMConversation) => boolean,
    update: (conversation: DMConversation) => void
  ): Promise<void> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(CONVERSATIONS_STORE, 'readwrite');
      const store = tx.objectStore(CONVERSATIONS_STORE);
      const request = store.openCursor();

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const conversation = cursor.value as DMConversation;
          if (shouldUpdate(conversation)) {
            update(conversation);
            cursor.update(conversation);
          }
          cursor.continue();
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Get total unread count across all conversations
   */
  public async getTotalUnreadCount(): Promise<number> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(CONVERSATIONS_STORE, 'readonly');
      const store = tx.objectStore(CONVERSATIONS_STORE);
      const request = store.getAll();

      request.onsuccess = () => {
        const conversations = request.result as DMConversation[];
        const total = conversations.reduce((sum, c) => sum + c.unreadCount, 0);
        resolve(total);
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Check if message exists by wrapId
   */
  public async hasMessage(wrapId: string): Promise<boolean> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(MESSAGES_STORE, 'readonly');
      const store = tx.objectStore(MESSAGES_STORE);
      const index = store.index('wrapId');
      const request = index.get(wrapId);

      request.onsuccess = () => resolve(!!request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get newest message timestamp (for subscription since parameter)
   */
  public async getNewestMessageTimestamp(): Promise<number> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(MESSAGES_STORE, 'readonly');
      const store = tx.objectStore(MESSAGES_STORE);
      const index = store.index('createdAt');
      const request = index.openCursor(null, 'prev');

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          resolve((cursor.value as DMMessage).createdAt);
        } else {
          resolve(0);
        }
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Load the { partnerPubkey → disappearingSeconds } mirror from localStorage.
   * Called on init, before any message is processed. Same eviction-survival
   * rationale as loadReadAnchorMirror.
   */
  private loadDisappearingMirror(pubkey: string): void {
    try {
      const obj = PerAccountLocalStorage.getInstance().getForPubkey<
        Record<string, number | undefined>
      >(StorageKeys.DM_DISAPPEARING_SETTINGS, pubkey, {});
      // Re-hydrate: drop keys whose value is undefined (treat as not present,
      // since JSON.stringify drops undefined values anyway).
      const entries = Object.entries(obj).filter(
        ([, v]) => v !== undefined
      ) as Array<[string, number]>;
      this.disappearingMirror = new Map(entries);
      diagLog('dms', 'disappearing_mirror_loaded', {
        count: this.disappearingMirror.size,
      });
    } catch (error) {
      this.disappearingMirror = new Map();
      diagLog('dms', 'disappearing_mirror_load_failed', {
        error: String(error),
      });
    }
  }

  /**
   * Persist the current disappearing-settings map to localStorage. Off (0) and
   * active (>0) values are stored; undecided (undefined) entries are dropped so
   * the prompt can re-fire if the conversation is somehow re-encountered.
   */
  private saveDisappearingMirror(): void {
    if (!this.currentUserPubkey) return;
    try {
      const obj: Record<string, number> = {};
      for (const [pk, secs] of this.disappearingMirror) {
        if (typeof secs === 'number') obj[pk] = secs;
      }
      PerAccountLocalStorage.getInstance().setForPubkey(
        StorageKeys.DM_DISAPPEARING_SETTINGS,
        this.currentUserPubkey,
        obj
      );
    } catch (error) {
      diagLog('dms', 'disappearing_mirror_save_failed', {
        error: String(error),
      });
    }
  }

  /**
   * Get the per-conversation disappearing setting (seconds).
   * Returns:
   *   undefined → undecided (no commitment yet)
   *   0         → off
   *   >0        → seconds
   *
   * Falls back to the localStorage mirror if the conversation record is
   * missing (e.g. after IndexedDB eviction), so the setting survives.
   */
  public async getDisappearing(
    partnerPubkey: string
  ): Promise<number | undefined> {
    await this.init();
    // In-memory mirror is fastest and survives eviction.
    if (this.disappearingMirror.has(partnerPubkey)) {
      return this.disappearingMirror.get(partnerPubkey);
    }
    // Fall back to the IndexedDB conversation record.
    const conv = await this.getConversation(partnerPubkey);
    if (conv && typeof conv.disappearingSeconds === 'number') {
      // Backfill the mirror so subsequent reads are fast.
      this.disappearingMirror.set(partnerPubkey, conv.disappearingSeconds);
      return conv.disappearingSeconds;
    }
    return undefined;
  }

  /**
   * Set the per-conversation disappearing setting. Writes through to both the
   * IndexedDB conversation record (upsert) and the localStorage mirror.
   *
   * Pass `undefined` to reset back to "undecided"; pass 0 for off; pass a
   * preset seconds value to enable. The value is the source of truth for
   * whether outgoing messages get an `expiration` tag (DMService.sendMessage).
   */
  public async setDisappearing(
    partnerPubkey: string,
    seconds: number | undefined
  ): Promise<void> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(CONVERSATIONS_STORE, 'readwrite');
      const store = tx.objectStore(CONVERSATIONS_STORE);
      const req = store.get(partnerPubkey);

      req.onsuccess = () => {
        const conv = (req.result as DMConversation | undefined) || {
          pubkey: partnerPubkey,
          lastMessageAt: 0,
          lastMessagePreview: '',
          unreadCount: 0,
          lastReadAt: 0,
        };
        conv.disappearingSeconds = seconds;
        // Keep lastPromptedPeerDuration in sync when accepting a new duration
        // so the same duration doesn't re-prompt. When `seconds` is undefined
        // (reset to undecided) or 0 (off), leave lastPromptedPeerDuration
        // untouched — the next incoming tagged message will re-prompt.
        if (typeof seconds === 'number' && seconds > 0) {
          conv.lastPromptedPeerDuration = seconds;
        }
        store.put(conv);
        this.disappearingMirror.set(partnerPubkey, seconds);
        this.saveDisappearingMirror();
        diagLog('dms', 'disappearing_set', {
          partner: partnerPubkey.slice(0, 8),
          seconds,
        });
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Read the peer duration we last prompted the user about (Yes or No).
   * Used by the view to decide whether a new incoming tagged message with
   * a given duration needs a fresh prompt or should be silently rejected
   * (already said No) / silently shown (already said Yes).
   */
  public async getLastPromptedPeerDuration(
    partnerPubkey: string
  ): Promise<number | undefined> {
    await this.init();
    const conv = await this.getConversation(partnerPubkey);
    return conv?.lastPromptedPeerDuration;
  }

  /**
   * Update the "last prompted peer duration" without touching our own
   * outgoing setting. Called from the No handler — the user explicitly
   * rejected the new duration, so we record it to silently reject future
   * messages with the same duration until the peer changes again.
   */
  public async setLastPromptedPeerDuration(
    partnerPubkey: string,
    seconds: number
  ): Promise<void> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(CONVERSATIONS_STORE, 'readwrite');
      const store = tx.objectStore(CONVERSATIONS_STORE);
      const req = store.get(partnerPubkey);

      req.onsuccess = () => {
        const conv = (req.result as DMConversation | undefined) || {
          pubkey: partnerPubkey,
          lastMessageAt: 0,
          lastMessagePreview: '',
          unreadCount: 0,
          lastReadAt: 0,
        };
        conv.lastPromptedPeerDuration = seconds;
        store.put(conv);
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Delete every message in a conversation whose computed peer-duration
   * (expiresAt - createdAt) equals `duration`. Used by the No handler to
   * drop all pending messages with the rejected duration. Only considers
   * incoming messages with expiresAt set.
   */
  public async deletePendingMessagesByDuration(
    partnerPubkey: string,
    duration: number
  ): Promise<number> {
    await this.init();
    let deleted = 0;

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(MESSAGES_STORE, 'readwrite');
      const store = tx.objectStore(MESSAGES_STORE);
      const index = store.index('conversationWith');
      const cursorReq = index.openCursor(IDBKeyRange.only(partnerPubkey));

      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          const m = cursor.value as DMMessage;
          if (
            typeof m.expiresAt === 'number' &&
            m.expiresAt - m.createdAt === duration
          ) {
            cursor.delete();
            deleted++;
          }
          cursor.continue();
        }
      };

      tx.oncomplete = () => {
        if (deleted > 0) {
          diagLog('dms', 'pending_messages_deleted', {
            partner: partnerPubkey.slice(0, 8),
            duration,
            deleted,
          });
        }
        resolve(deleted);
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Delete every message whose expiresAt is in the past.
   * Used by the periodic sweep timer (DMService.startExpirySweepTimer).
   *
   * Returns the set of partner pubkeys whose conversations had at least one
   * message removed, so the caller can emit per-conversation events that
   * re-render the open ConversationView.
   *
   * ALSO recomputes `lastMessageAt` and `lastMessagePreview` for each affected
   * conversation — otherwise the messages-list overview shows stale previews
   * of messages that no longer exist.
   */
  public async deleteExpiredBefore(
    now: number
  ): Promise<{ partnerPubkeys: Set<string>; count: number }> {
    await this.init();

    const affected = new Set<string>();
    let count = 0;

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(MESSAGES_STORE, 'readwrite');
      const messagesStore = tx.objectStore(MESSAGES_STORE);

      // The expiresAt index excludes records where the field is undefined, so
      // never-expiring messages are skipped cheaply. upperBound(now, false)
      // matches everything strictly ≤ now (already-expired).
      const index = messagesStore.index('expiresAt');
      const range = IDBKeyRange.upperBound(now, false);
      const cursorReq = index.openCursor(range);

      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          const msg = cursor.value as DMMessage;
          affected.add(msg.conversationWith);
          count++;
          cursor.delete();
          cursor.continue();
        }
      };

      tx.oncomplete = async () => {
        if (count > 0) {
          diagLog('dms', 'expired_sweep', { count, partners: affected.size });
          // Recompute lastMessageAt + lastMessagePreview for each affected
          // conversation so the messages-list doesn't show ghost previews.
          // Open a fresh transaction per conversation (the deletion tx is
          // already completed at this point).
          for (const partnerPubkey of affected) {
            await this.recomputeConversationPreview(partnerPubkey);
          }
        }
        resolve({ partnerPubkeys: affected, count });
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Recompute `lastMessageAt` and `lastMessagePreview` for a conversation by
   * scanning its remaining messages. Called after sweep deletions so the
   * messages-list overview doesn't show previews of messages that no longer
   * exist.
   *
   * Uses TWO separate transactions: first read messages to find the newest,
   * then update the conversation record. (The previous single-transaction
   * approach tried to read/write the conversations store AFTER the messages
   * transaction had already completed — which silently failed in IDB.)
   */
  private async recomputeConversationPreview(
    partnerPubkey: string
  ): Promise<void> {
    await this.init();

    // Step 1: find the latest remaining message for this partner (read-only).
    const latestMessage = await new Promise<DMMessage | null>(
      (resolve, reject) => {
        const tx = this.db!.transaction(MESSAGES_STORE, 'readonly');
        const index = tx.objectStore(MESSAGES_STORE).index('conversationWith');
        const cursorReq = index.openCursor(IDBKeyRange.only(partnerPubkey));
        let latest: DMMessage | null = null;

        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            const m = cursor.value as DMMessage;
            if (!latest || m.createdAt > latest.createdAt) latest = m;
            cursor.continue();
          } else {
            resolve(latest);
          }
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      }
    );

    // Step 2: update the conversation record (readwrite).
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(CONVERSATIONS_STORE, 'readwrite');
      const store = tx.objectStore(CONVERSATIONS_STORE);
      const req = store.get(partnerPubkey);

      req.onsuccess = () => {
        const conv = req.result as DMConversation | undefined;
        if (!conv) {
          resolve();
          return;
        }
        if (latestMessage) {
          conv.lastMessageAt = latestMessage.createdAt;
          conv.lastMessagePreview = (latestMessage.content || '').slice(0, 100);
        } else {
          conv.lastMessageAt = 0;
          conv.lastMessagePreview = '';
        }
        store.put(conv);
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Clear all DM data for current user
   * Note: With per-user DBs, this is rarely needed - just close the DB on logout
   */
  public async clear(): Promise<void> {
    if (!this.db) return;

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(
        [MESSAGES_STORE, CONVERSATIONS_STORE],
        'readwrite'
      );
      tx.objectStore(MESSAGES_STORE).clear();
      tx.objectStore(CONVERSATIONS_STORE).clear();

      tx.oncomplete = () => {
        // Explicit data wipe also clears the mirrors, so a later re-sync
        // starts genuinely fresh instead of resurrecting old anchors/settings.
        this.readAnchorMirror = new Map();
        this.saveReadAnchorMirror();
        this.disappearingMirror = new Map();
        this.saveDisappearingMirror();
        this.systemLogger.info('DMStore', 'All DM data cleared');
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Close database connection (called on logout)
   * Does NOT delete data - just closes connection
   */
  public close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.initPromise = null;
    this.currentUserPubkey = null;
    // Drop the in-memory anchor mirror so it can't leak into another account.
    // The localStorage copy stays (per-account) for the next login.
    this.readAnchorMirror = new Map();
    // Same for the disappearing-messages mirror.
    this.disappearingMirror = new Map();
    this.systemLogger.info('DMStore', 'Database connection closed');
  }
}
