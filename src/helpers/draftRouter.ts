/**
 * Reopen a draft in the appropriate composer, prefilled with its content.
 * Lazy imports keep the two composers free of a static circular dependency.
 */

import type { NoteDraft } from '../services/NoteDraftService';
import { openNoteComposer } from './composerHandoff';

export function openDraftInComposer(draft: NoteDraft): void {
  if (draft.type === 'reply' && draft.parentEventId) {
    void import('../components/reply/ReplyModal').then(({ ReplyModal }) =>
      ReplyModal.getInstance().show(
        draft.parentEventId!,
        undefined,
        draft.content
      )
    );
  } else {
    openNoteComposer({ initialContent: draft.content });
  }
}
