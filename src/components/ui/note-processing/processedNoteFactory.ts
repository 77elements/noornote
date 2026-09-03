/**
 * Shared ProcessedNote assembly for the kind-specific processors.
 *
 * Every processor differs only in `type` + `content`; the skeleton (event-id
 * guard, non-blocking author profile lookup, canonical 3-field profile
 * spread) is identical — consolidated here so the processors stay thin.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote } from '../types/NoteTypes';
import {
  ContentProcessor,
  type ProcessedContent,
} from '../../../services/ContentProcessor';

const contentProcessor = ContentProcessor.getInstance();

export function buildProcessedNote(
  event: NostrEvent,
  opts: {
    type: ProcessedNote['type'];
    content: ProcessedContent;
  }
): ProcessedNote {
  const eventId = event.id;
  if (!eventId) {
    throw new Error('Event ID is required');
  }

  const authorProfile = contentProcessor.getNonBlockingProfile(event.pubkey);

  const result: ProcessedNote = {
    id: eventId,
    type: opts.type,
    timestamp: event.created_at,
    author: {
      pubkey: event.pubkey,
    },
    content: opts.content,
    rawEvent: event,
  };

  if (authorProfile) {
    result.author.profile = {
      ...(authorProfile.name !== undefined && { name: authorProfile.name }),

      ...(authorProfile.display_name !== undefined && {
        display_name: authorProfile.display_name,
      }),

      ...(authorProfile.picture !== undefined && {
        picture: authorProfile.picture,
      }),
    };
  }

  return result;
}
