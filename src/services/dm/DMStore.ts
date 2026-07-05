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
}

const DB_NAME_PREFIX = 'noornote_dm_';
const DB_VERSION = 4; // v4: added optional deleted/deletedAt (additive, no migration)
const MESSAGES_STORE = 'messages';
const CONVERSATIONS_STORE = 'conversations';

export class DMStore {
  private static instance: DMStore;
  private db: IDBDatabase | null = null;
  private systemLogger: SystemLogger;
  private initPromise: Promise<void> | null = null;
  private currentUserPubkey: string | null = null;

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
      this.systemLogger.warn('DMStore', 'init() called without pubkey and no current user');
      return;
    }

    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    const dbName = DB_NAME_PREFIX + pubkey;

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, DB_VERSION);

      request.onerror = () => {
        this.systemLogger.error('DMStore', 'Failed to open IndexedDB:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        this.systemLogger.info('DMStore', `IndexedDB initialized for user ${pubkey.slice(0, 8)}...`);
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Messages store with indexes
        if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
          const messagesStore = db.createObjectStore(MESSAGES_STORE, { keyPath: 'id' });
          messagesStore.createIndex('conversationWith', 'conversationWith', { unique: false });
          messagesStore.createIndex('createdAt', 'createdAt', { unique: false });
          messagesStore.createIndex('wrapId', 'wrapId', { unique: true });
        }

        // Conversations store
        if (!db.objectStoreNames.contains(CONVERSATIONS_STORE)) {
          const conversationsStore = db.createObjectStore(CONVERSATIONS_STORE, { keyPath: 'pubkey' });
          conversationsStore.createIndex('lastMessageAt', 'lastMessageAt', { unique: false });
        }

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
      const tx = this.db!.transaction([MESSAGES_STORE, CONVERSATIONS_STORE], 'readwrite');
      const messagesStore = tx.objectStore(MESSAGES_STORE);
      const conversationsStore = tx.objectStore(CONVERSATIONS_STORE);

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
          const isNewer = !existing || message.createdAt > existing.lastMessageAt;

          // Soft-delete handling: a message newer than the delete cutoff
          // resurrects the conversation; an older one (e.g. re-synced history)
          // keeps it hidden and does NOT bump unread.
          const wasDeleted = existing?.deleted === true;
          const resurrect = wasDeleted && message.createdAt > (existing?.deletedAt || 0);
          const staysDeleted = wasDeleted && !resurrect;

          // Only count as unread if:
          // 1. Not my own message
          // 2. Message is newer than lastReadAt (or no lastReadAt exists = 0)
          // 3. The conversation isn't staying soft-deleted
          const lastReadAt = existing?.lastReadAt || 0;
          const shouldIncrementUnread = !message.isMine && message.createdAt > lastReadAt && !staysDeleted;

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
            lastMessageAt: isNewer ? message.createdAt : existing!.lastMessageAt,
            lastMessagePreview: isNewer ? message.content.slice(0, 100) : existing!.lastMessagePreview,
            unreadCount: shouldIncrementUnread
              ? (existing?.unreadCount || 0) + 1
              : (existing?.unreadCount || 0),
            lastReadAt: lastReadAt,
            ...(subject && { subject }),
            // Keep hidden only while staying deleted; resurrection/new convo clears it.
            ...(staysDeleted && { deleted: true, deletedAt: existing!.deletedAt })
          };

          conversationsStore.put(conversation);
        };
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Get messages for a conversation (paginated)
   */
  public async getMessages(partnerPubkey: string, limit: number = 50, before?: number): Promise<DMMessage[]> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction([MESSAGES_STORE, CONVERSATIONS_STORE], 'readonly');

      // Look up the soft-delete cutoff first, so messages up to deletedAt stay hidden.
      const convRequest = tx.objectStore(CONVERSATIONS_STORE).get(partnerPubkey);
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
  public async getConversations(limit?: number, offset: number = 0): Promise<DMConversation[]> {
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
  public async getConversation(partnerPubkey: string): Promise<DMConversation | null> {
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
        }
        resolve();
      };

      tx.onerror = () => reject(tx.error);
    });
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
      const tx = this.db!.transaction([MESSAGES_STORE, CONVERSATIONS_STORE], 'readwrite');
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
      (c) => c.unreadCount > 0,
      (c) => { c.unreadCount = 0; c.lastReadAt = now; }
    );
  }

  /**
   * Mark all conversations as unread (set unread count to 1)
   */
  public async markAllAsUnread(): Promise<void> {
    await this.updateAllConversations(
      (c) => c.unreadCount === 0,
      (c) => { c.unreadCount = 1; c.lastReadAt = 0; }
    );
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
   * Clear all DM data for current user
   * Note: With per-user DBs, this is rarely needed - just close the DB on logout
   */
  public async clear(): Promise<void> {
    if (!this.db) return;

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction([MESSAGES_STORE, CONVERSATIONS_STORE], 'readwrite');
      tx.objectStore(MESSAGES_STORE).clear();
      tx.objectStore(CONVERSATIONS_STORE).clear();

      tx.oncomplete = () => {
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
    this.systemLogger.info('DMStore', 'Database connection closed');
  }
}
