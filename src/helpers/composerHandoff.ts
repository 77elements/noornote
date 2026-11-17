/**
 * One-shot handoff for pre-filled composer opens (initial content, NIP-84
 * highlight source). The v2 Focus UI opens the note composer as a flat
 * view at /timeline/new-note — navigation there cannot carry a payload,
 * so the caller stashes the request here and the composer view consumes
 * it on mount (in-memory, consumed exactly once).
 */

import type { HighlightSource } from '../components/post/PostNoteModal';
import { isFocusUiEnabled } from './focusUiSetting';
import { delegateToFocusUi } from './focusUiNavigation';

export interface PendingComposerRequest {
  initialContent?: string;
  highlightSource?: HighlightSource;
}

export type { HighlightSource };

let pending: PendingComposerRequest | null = null;

/** Stash a composer request for the next composer mount. */
export function setPendingComposerRequest(req: PendingComposerRequest): void {
  pending = req;
}

/** Consume the stashed request (returns null when none is pending). */
export function takePendingComposerRequest(): PendingComposerRequest | null {
  const req = pending;
  pending = null;
  return req;
}

/**
 * Open the note composer with an optional prefill/highlight request.
 * Focus UI: stash the request and open the flat composer view via the
 * focus navigation seam (/timeline/new-note). Classic: the PostNoteModal
 * (unchanged v1 behavior).
 */
export function openNoteComposer(
  request: string | PendingComposerRequest = {}
): void {
  if (isFocusUiEnabled()) {
    setPendingComposerRequest(
      typeof request === 'string' ? { initialContent: request } : request
    );
    delegateToFocusUi('new-note');
    return;
  }
  void import('../components/post/PostNoteModal').then(({ PostNoteModal }) =>
    PostNoteModal.getInstance().show(
      request as
        | string
        | { initialContent?: string; highlightSource?: HighlightSource }
    )
  );
}
