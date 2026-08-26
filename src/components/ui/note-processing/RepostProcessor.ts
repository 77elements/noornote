/**
 * RepostProcessor - Process kind:6 reposts
 * Extracts from: NoteUI.processRepost()
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote } from '../types/NoteTypes';
import { ContentProcessor } from '../../../services/ContentProcessor';
import { PollProcessor } from './PollProcessor';
import { PictureNoteProcessor } from './PictureNoteProcessor';
import { VideoNoteProcessor } from './VideoNoteProcessor';

export class RepostProcessor {
  private static contentProcessor = ContentProcessor.getInstance();

  /**
   * Process kind:6 repost
   * SYNCHRONOUS - no blocking calls
   */
  static process(event: NostrEvent): ProcessedNote {
    const reposterProfile =
      RepostProcessor.contentProcessor.getNonBlockingProfile(event.pubkey);
    const originalAuthorPubkey =
      RepostProcessor.extractOriginalAuthorPubkey(event);

    let originalAuthorProfile;
    if (originalAuthorPubkey) {
      originalAuthorProfile =
        RepostProcessor.contentProcessor.getNonBlockingProfile(
          originalAuthorPubkey
        );
    }

    let originalContent = 'Reposted content';
    let originalEvent: NostrEvent | null = null;

    try {
      if (event.content && event.content.trim()) {
        originalEvent = JSON.parse(event.content) as NostrEvent;
        if (originalEvent && originalEvent.content) {
          originalContent = originalEvent.content;
        }
      }
    } catch (error) {
      console.warn('⚠️ Could not parse repost content as JSON');
    }

    // For media events (kind 20/21/22), delegate to specialized processors
    // so imeta tags are extracted and media is rendered properly.
    let processedContent;
    if (originalEvent && originalEvent.kind === 20) {
      processedContent =
        RepostProcessor.contentProcessor.processContentWithTags(
          originalContent,
          originalEvent.tags
        );
      PictureNoteProcessor.prependPictureContent(
        processedContent,
        originalEvent.tags
      );
    } else if (
      originalEvent &&
      (originalEvent.kind === 21 || originalEvent.kind === 22)
    ) {
      processedContent =
        RepostProcessor.contentProcessor.processContentWithTags(
          originalContent,
          originalEvent.tags
        );
      VideoNoteProcessor.prependVideoContent(
        processedContent,
        originalEvent.tags
      );
    } else {
      processedContent = originalEvent
        ? RepostProcessor.contentProcessor.processContentWithTags(
            originalContent,
            originalEvent.tags
          )
        : RepostProcessor.contentProcessor.processContent(originalContent);
    }

    // Build profile objects with explicit undefined handling for exactOptionalPropertyTypes
    const buildProfile = (
      profile: { name?: string; display_name?: string; picture?: string } | null
    ):
      | { name?: string; display_name?: string; picture?: string }
      | undefined => {
      if (!profile) return undefined;
      const result: { name?: string; display_name?: string; picture?: string } =
        {};
      if (profile.name !== undefined) result.name = profile.name;
      if (profile.display_name !== undefined)
        result.display_name = profile.display_name;
      if (profile.picture !== undefined) result.picture = profile.picture;
      return Object.keys(result).length > 0 ? result : undefined;
    };

    // Build author/reposter with conditional profile property for exactOptionalPropertyTypes
    const buildAuthorObject = (
      pubkey: string,
      profile: ReturnType<typeof buildProfile>
    ): ProcessedNote['author'] => {
      if (profile) {
        return { pubkey, profile };
      }
      return { pubkey };
    };

    // Priority: embedded event pubkey (authoritative) > p-tag > reposter
    const authorPubkey =
      originalEvent?.pubkey ?? originalAuthorPubkey ?? event.pubkey;
    const authorProfile =
      authorPubkey !== event.pubkey
        ? buildProfile(
            authorPubkey === originalAuthorPubkey
              ? (originalAuthorProfile ?? null)
              : (RepostProcessor.contentProcessor.getNonBlockingProfile(
                  authorPubkey
                ) ?? null)
          )
        : buildProfile(reposterProfile);

    const reposterProfileObj = buildProfile(reposterProfile);

    const result: ProcessedNote = {
      id: event.id ?? '',
      type: 'repost',
      timestamp: originalEvent?.created_at ?? event.created_at,
      author: buildAuthorObject(authorPubkey, authorProfile),
      reposter: buildAuthorObject(event.pubkey, reposterProfileObj),
      content: processedContent,
      rawEvent: event,
    };

    if (originalEvent) {
      result.repostedEvent = originalEvent;
      // Extract poll data if reposted event is a NIP-88 poll (kind 1068)
      if (originalEvent.kind === 1068) {
        result.pollData = PollProcessor.extractPollData(originalEvent.tags);
      }
    }

    return result;
  }

  /**
   * Extract original author pubkey from repost tags
   */
  private static extractOriginalAuthorPubkey(event: NostrEvent): string | null {
    const pTag = event.tags.find(tag => tag[0] === 'p');
    return pTag?.[1] ?? null;
  }
}
