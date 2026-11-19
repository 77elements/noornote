/**
 * Detached details (v2) — Phase 5 of the hidden objects feature
 * (docs/todos/hidden-objects.md).
 *
 * A hidden owner's detail view must still be reachable from VISIBLE
 * surfaces: a quoted note clicked in the articles column (social hidden)
 * or an article embed clicked in the timeline (articles hidden) renders
 * the detail DIRECTLY in the active column, as a detached component —
 * without the owner object (no surface, no list, no settings, no addon
 * runtime). This is a FEATURE, not a dependency error (the user's
 * explicit SNV-detach decision).
 *
 * Each factory mirrors the owner surface's createDetail import; the
 * component contract (el + destroy) matches a classic view handle. The
 * stage owns the swap into/out of the active column (see
 * FocusStage.openDetachedDetail) — including the history entry, so the
 * global back button unwinds it.
 */

import type { SingleNoteView } from '../components/views/SingleNoteView';
import type { ArticleView } from '../components/views/ArticleView';

export interface DetachedDetailComponent {
  el: HTMLElement;
  destroy(): void;
}

type DetachedDetailFactory = (
  param?: string
) => Promise<DetachedDetailComponent>;

/** View types whose owner can be hidden, keyed by seam view type. */
export const DETACHED_DETAILS: Record<string, DetachedDetailFactory> = {
  'single-note': async param => {
    const { SingleNoteView: SNV } = await import(
      '../components/views/SingleNoteView'
    );
    const view: SingleNoteView = new SNV(param as string);
    return { el: view.getElement(), destroy: () => view.destroy() };
  },
  article: async param => {
    const { ArticleView: AV } = await import('../components/views/ArticleView');
    const view: ArticleView = new AV(param as string);
    return { el: view.getElement(), destroy: () => view.destroy() };
  },
};
