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
import { buildProcessedNote } from './processedNoteFactory';
import { getTag } from '../../../helpers/tagUtils';
import { getLiveStreamStatus } from '../../../helpers/getLiveStreamStatus';

export class LiveStreamProcessor {
  static process(event: NostrEvent): ProcessedNote {
    const title = getTag(event.tags, 'title') || 'Untitled Stream';

    return buildProcessedNote(event, {
      type: 'live-stream',
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
    });
  }

  /** Resolve the *effective* NIP-53 status of a 30311 event, applying the
   *  recommended staleness guards. Exposed as a pass-through so callers that
   *  already hold the ProcessedNote don't need to import getLiveStreamStatus
   *  separately. */
  static getStatus(event: NostrEvent): ReturnType<typeof getLiveStreamStatus> {
    return getLiveStreamStatus(event);
  }
}
