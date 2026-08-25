/**
 * LiveStreamProcessor — NIP-53 Live Activity / Live Stream (kind 30311)
 *
 * addressable event advertising a live stream (zap.stream, streamstr, …).
 * The visible body is rendered by LiveStreamRenderer via the shared
 * ArticlePreviewRenderer.createLiveStreamCard pipeline; this processor just
 * produces a ProcessedNote with empty text content so NoteStructureBuilder
 * produces a normal shell (header + ISL + click-to-SNV).
 *
 * Tags (NIP-53): title, summary, image, streaming, recording, starts, ends,
 * status (planned|live|ended), current_participants, total_participants,
 * p (with role marker, e.g. "host"), relays, service, t.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote } from '../types/NoteTypes';
import { ContentProcessor } from '../../../services/ContentProcessor';
import { getTag } from '../../../helpers/tagUtils';
import { getLiveStreamStatus } from '../../../helpers/getLiveStreamStatus';

export class LiveStreamProcessor {
  private static contentProcessor = ContentProcessor.getInstance();

  static process(event: NostrEvent): ProcessedNote {
    const eventId = event.id;
    if (!eventId) throw new Error('Event ID is required');

    const authorProfile =
      LiveStreamProcessor.contentProcessor.getNonBlockingProfile(event.pubkey);
    const title = getTag(event.tags, 'title') || 'Untitled Stream';

    const result: ProcessedNote = {
      id: eventId,
      type: 'live-stream',
      timestamp: event.created_at,
      author: { pubkey: event.pubkey },
      content: {
        // Body is rendered separately by LiveStreamRenderer; keep text/html
        // empty so NoteStructureBuilder produces a clean shell. The title is
        // still mirrored into .text so "search within feed" / debug helpers
        // have something readable.
        text: title,
        html: '',
        media: [],
        links: [],
        hashtags: [],
        quotedReferences: [],
        bolt11Invoices: [],
      },
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

  /** Resolve the *effective* NIP-53 status of a 30311 event, applying the
   *  recommended staleness guards. Exposed as a pass-through so callers that
   *  already hold the ProcessedNote don't need to import getLiveStreamStatus
   *  separately. */
  static getStatus(event: NostrEvent): ReturnType<typeof getLiveStreamStatus> {
    return getLiveStreamStatus(event);
  }
}
