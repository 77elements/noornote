/**
 * CurationSetProcessor - NIP-51 article curation set (kind 30004).
 * Zap Cooking publishes these as "Recipe Packs" (the referenced kind-30023
 * articles are recipes). Rendered as a light nn-card; the referenced items
 * are resolved only in the SNV (see CurationSetItems), so cards in feeds
 * and quotes cost zero extra relay fetches.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote } from '../types/NoteTypes';
import { buildProcessedNote } from './processedNoteFactory';

export class CurationSetProcessor {
  static process(event: NostrEvent): ProcessedNote {
    return buildProcessedNote(event, {
      type: 'curation-set',
      content: {
        text: '',
        html: '',
        media: [],
        links: [],
        hashtags: [],
        quotedReferences: [],
        bolt11Invoices: [],
      },
    });
  }
}
