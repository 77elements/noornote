/**
 * PostService - Note Publishing Service
 * Handles creation and publishing of Kind 1 (short text note) and Kind 1068 (poll) events
 *
 * Kind 1: Short text note (basic Nostr post)
 * Kind 1068: Poll (NIP-88)
 * NIP-01: https://github.com/nostr-protocol/nips/blob/master/01.md
 * NIP-10: https://github.com/nostr-protocol/nips/blob/master/10.md (Reply threading)
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { AuthService } from './AuthService';
import { NostrTransport } from './transport/NostrTransport';
import { SystemLogger } from '../components/system/SystemLogger';
import { ErrorService } from './ErrorService';
import { decodeNip19 } from './NostrToolsAdapter';
import { ToastService } from './ToastService';
import type { PollData } from '../components/poll/PollCreator';
import { RelayConfig } from './RelayConfig';

export interface PostOptions {
  /** Note content (plain text) */
  content: string;
  /** Target relays to publish to */
  relays: string[];
  /** Content warning (NSFW marker) - NIP-36 */
  contentWarning?: boolean;
  /** Poll data (NIP-88) - makes this a Kind 1068 event */
  pollData?: PollData;
  /** Quoted event data (NIP-18) - adds q tags for quoted reposts (NORMAL NOTES) */
  quotedEvent?: {
    eventId: string;
    authorPubkey: string;
    relayHint?: string;
  };
  /**
   * LONG-FORM ARTICLES ONLY: Quoted article data
   * Uses a-tag with addressable identifier instead of q-tag
   */
  quotedArticle?: {
    addressableId: string;  // Format: "kind:pubkey:d-tag"
    authorPubkey: string;
    relayHint?: string;
  };
}

export interface ReplyOptions {
  /** Reply content (plain text) */
  content: string;
  /** Parent event being replied to */
  parentEvent: NostrEvent;
  /** Target relays to publish to */
  relays: string[];
  /** Content warning (NSFW marker) - NIP-36 */
  contentWarning?: boolean;
}

export class PostService {
  private static instance: PostService;
  private authService: AuthService;
  private transport: NostrTransport;
  private systemLogger: SystemLogger;

  private constructor() {
    this.authService = AuthService.getInstance();
    this.transport = NostrTransport.getInstance();
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): PostService {
    if (!PostService.instance) {
      PostService.instance = new PostService();
    }
    return PostService.instance;
  }

  /**
   * Create and publish a Kind 1 note event or Kind 1068 poll event
   *
   * @param options - Post configuration
   * @returns Promise<boolean> - Success status
   */
  public async createPost(options: PostOptions): Promise<boolean> {
    const { content, relays, contentWarning, pollData, quotedEvent, quotedArticle } = options;

    // Validate authentication
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.systemLogger.error('PostService', 'Cannot create post: User not authenticated');
      return false;
    }

    // Validate content (polls can be posted without content)
    if (!pollData && (!content || content.trim().length === 0)) {
      this.systemLogger.error('PostService', 'Cannot create post: Content is empty');
      return false;
    }

    // Validate relays
    if (!relays || relays.length === 0) {
      this.systemLogger.error('PostService', 'Cannot create post: No relays specified');
      return false;
    }

    try {
      // Build tags array
      const tags: string[][] = [];

      // Determine event kind
      const kind = pollData ? 1068 : 1;

      // Add content-warning tag if NSFW (NIP-36)
      if (contentWarning) {
        tags.push(['content-warning', '']);
      }

      // Extract mentions from content (nostr:npub... or nostr:nprofile...)
      const { extractPubkeysFromText } = await import('../helpers/nip19');
      const mentionedPubkeys = extractPubkeysFromText(content);

      // Add p-tags for mentioned users
      mentionedPubkeys.forEach(pubkey => {
        tags.push(['p', pubkey]);
      });

      // Add quoted event tags if this is a quoted repost (NIP-18)
      // NORMAL NOTES: Use q-tag with event ID
      if (quotedEvent) {
        const qTag = ['q', quotedEvent.eventId];
        if (quotedEvent.relayHint) {
          qTag.push(quotedEvent.relayHint);
        }
        qTag.push(quotedEvent.authorPubkey);
        tags.push(qTag);

        // Add p-tag for quoted author if not already mentioned
        if (!mentionedPubkeys.has(quotedEvent.authorPubkey)) {
          tags.push(['p', quotedEvent.authorPubkey]);
        }
      }

      // LONG-FORM ARTICLES: Use a-tag with addressable identifier instead of q-tag
      if (quotedArticle) {
        const aTag = ['a', quotedArticle.addressableId];
        if (quotedArticle.relayHint) {
          aTag.push(quotedArticle.relayHint);
        }
        tags.push(aTag);

        // Add p-tag for quoted author if not already mentioned
        if (!mentionedPubkeys.has(quotedArticle.authorPubkey)) {
          tags.push(['p', quotedArticle.authorPubkey]);
        }
      }

      // Add poll tags if this is a poll (NIP-88)
      if (pollData) {
        // Add option tags (id, label)
        pollData.options.forEach((option) => {
          tags.push(['option', option.id, option.label]);
        });

        // Add polltype tag (NIP-88: "singlechoice" or "multiplechoice")
        tags.push(['polltype', pollData.multipleChoice ? 'multiplechoice' : 'singlechoice']);

        // Add endsAt tag if specified (NIP-88)
        if (pollData.endDate) {
          tags.push(['endsAt', pollData.endDate.toString()]);
        }

        // Add relay tags if specified (NIP-88)
        if (pollData.relayUrls && pollData.relayUrls.length > 0) {
          pollData.relayUrls.forEach((relayUrl) => {
            tags.push(['relay', relayUrl]);
          });
        }
      }

      // Build unsigned event
      const unsignedEvent = {
        kind,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: content.trim(),
        pubkey: currentUser.pubkey
      };

      // Sign event using browser extension
      const signedEvent = await this.authService.signEvent(unsignedEvent);

      if (!signedEvent) {
        this.systemLogger.error('PostService', 'Failed to sign post event');
        return false;
      }

      // Publish to specified relays
      await this.transport.publish(relays, signedEvent);

      this.systemLogger.info(
        'PostService',
        `${kind === 1068 ? 'Poll' : 'Post'} published to ${relays.length} relay(s): ${signedEvent.id?.slice(0, 8)}...`
      );

      // Show success toast to user
      ToastService.show(
        kind === 1068 ? 'Poll posted successfully!' : 'Note posted successfully!',
        'success'
      );

      return true;
    } catch (error) {
      // Centralized error handling with user notification
      ErrorService.handle(
        error,
        'PostService.createPost',
        true,
        'Failed to post note. Please try again.'
      );
      return false;
    }
  }

  /**
   * Create and publish a reply to a note (Kind 1 event with NIP-10 threading)
   *
   * NIP-10 Threading:
   * - Reply to root: ["e", <root-id>, <hint>, "root", <root-author>]
   * - Reply to reply: ["e", <root-id>, <hint>, "root"] + ["e", <parent-id>, <hint>, "reply", <parent-author>]
   * - P-tags: [<parent-author>, ...all p-tags from parent event]
   *
   * @param options - Reply configuration
   * @returns Promise<NostrEvent | null> - Signed reply event on success, null on failure
   */
  public async createReply(options: ReplyOptions): Promise<NostrEvent | null> {
    const { content, parentEvent, relays, contentWarning } = options;

    // Validate authentication
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.systemLogger.error('PostService', 'Cannot create reply: User not authenticated');
      return null;
    }

    // Validate content
    if (!content || content.trim().length === 0) {
      this.systemLogger.error('PostService', 'Cannot create reply: Content is empty');
      return null;
    }

    // Validate relays
    if (!relays || relays.length === 0) {
      this.systemLogger.error('PostService', 'Cannot create reply: No relays specified');
      return null;
    }

    try {
      // Build tags array
      const tags: string[][] = [];

      // Add content-warning tag if NSFW (NIP-36)
      if (contentWarning) {
        tags.push(['content-warning', '']);
      }

      // NIP-10: Build e-tags (root/reply markers) and p-tags
      const { eTags, pTags } = this.buildReplyTags(parentEvent);
      tags.push(...eTags);
      tags.push(...pTags);

      // Build unsigned event
      const unsignedEvent = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: content.trim(),
        pubkey: currentUser.pubkey
      };

      // Sign event using browser extension
      const signedEvent = await this.authService.signEvent(unsignedEvent);

      if (!signedEvent) {
        this.systemLogger.error('PostService', 'Failed to sign reply event');
        return null;
      }

      this.systemLogger.info('PostService', `✅ Reply event signed: ${signedEvent.id?.slice(0, 8)}`);

      // Publish to specified relays
      await this.transport.publish(relays, signedEvent);

      this.systemLogger.info(
        'PostService',
        `Reply published to ${relays.length} relay(s): ${signedEvent.id?.slice(0, 8)}...`
      );

      // Show success toast to user
      ToastService.show('Reply posted successfully!', 'success');

      this.systemLogger.info('PostService', `🎯 Returning signed event: ${signedEvent.id?.slice(0, 8)}`);
      return signedEvent;
    } catch (error) {
      // Centralized error handling with user notification
      ErrorService.handle(
        error,
        'PostService.createReply',
        true,
        'Failed to post reply. Please try again.'
      );
      return null;
    }
  }

  /**
   * Build NIP-10 reply tags (e-tags with markers and p-tags)
   *
   * Logic:
   * 1. Check if parent has a "root" e-tag (parent is a reply)
   * 2. If yes: Use that root + add parent as "reply"
   * 3. If no: Parent IS the root
   *
   * @param parentEvent - The event being replied to
   * @returns { eTags, pTags } - Arrays of e-tags and p-tags
   */
  private buildReplyTags(parentEvent: NostrEvent): { eTags: string[][]; pTags: string[][] } {
    const eTags: string[][] = [];
    const pTags: string[][] = [];
    const relayConfig = RelayConfig.getInstance();

    // Get relay hint for parent event (first write relay as default)
    const writeRelays = relayConfig.getWriteRelays();
    const relayHint = writeRelays.length > 0 ? writeRelays[0] : '';

    // Check if parent event has a "root" marker e-tag
    const parentRootTag = parentEvent.tags.find(
      tag => tag[0] === 'e' && tag[3] === 'root'
    );

    if (parentRootTag) {
      // Parent is a reply → Use its root as our root
      const rootEventId = parentRootTag[1];
      const rootRelayHint = parentRootTag[2] || '';
      const rootPubkey = parentRootTag[4] || '';

      // Add root e-tag
      eTags.push(['e', rootEventId, rootRelayHint, 'root', rootPubkey]);

      // Add parent as reply e-tag
      eTags.push(['e', parentEvent.id, relayHint, 'reply', parentEvent.pubkey]);
    } else {
      // Parent IS the root → Add parent as root
      eTags.push(['e', parentEvent.id, relayHint, 'root', parentEvent.pubkey]);
    }

    // NIP-10: Build p-tags (all participants in thread)
    // Add parent author first
    pTags.push(['p', parentEvent.pubkey]);

    // Add all p-tags from parent event (avoid duplicates)
    const seenPubkeys = new Set<string>([parentEvent.pubkey]);

    parentEvent.tags.forEach(tag => {
      if (tag[0] === 'p' && tag[1] && !seenPubkeys.has(tag[1])) {
        pTags.push(['p', tag[1]]);
        seenPubkeys.add(tag[1]);
      }
    });

    return { eTags, pTags };
  }

}
