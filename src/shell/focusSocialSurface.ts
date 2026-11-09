/**
 * Focus surface: Social Media (v2).
 *
 * Wraps the classic TimelineView (feed) and SingleNoteView (note detail)
 * into ONE surface for the focus column. Note clicks arrive via the
 * focusUiNavigation seam (ViewNavigationController delegates here while
 * the shell is mounted): the SNV renders INSIDE the column — the classic
 * SCC tab system does not exist in the shell. The back control returns
 * to the feed. The URL follows along (/timeline ↔ /note/:nevent) without
 * touching the Router's view mounting.
 *
 * The feed view is cached: back preserves feed + scroll position.
 */

import type {
  FocusDomainSurface,
  FocusDomainSurfaceView,
} from './focusDomains';
import { createFocusSurfaceFrame } from './focusSurfaceFrame';
import { Router } from '../services/Router';

export class SocialSurface implements FocusDomainSurfaceView {
  private frame = createFocusSurfaceFrame('focus-surface--social', () =>
    this.showFeed()
  );

  private listView:
    | import('../components/views/TimelineView').TimelineView
    | null = null;
  private detailView:
    | import('../components/views/SingleNoteView').SingleNoteView
    | null = null;
  private detailEl: HTMLElement | null = null;

  constructor() {
    // Feed mounts immediately — the surface IS the social domain's content.
    void this.ensureFeed().then(feed => {
      if (feed) this.frame.element.appendChild(feed.getElement());
    });
  }

  /** The surface contract: this object doubles as the view handle. */
  asSurface(): FocusDomainSurface {
    return { element: this.frame.element, view: this };
  }

  /**
   * Focus navigation seam: render the note detail in-column. Returns
   * false for view types this surface does not own (falls through to
   * the classic navigation).
   */
  handleFocusNav(viewType: string, param?: string): boolean {
    if (viewType !== 'single-note' || !param) return false;
    void this.showNote(param);
    return true;
  }

  private async ensureFeed(): Promise<
    import('../components/views/TimelineView').TimelineView | null
  > {
    if (!this.listView) {
      const { TimelineView } = await import('../components/views/TimelineView');
      this.listView = new TimelineView();
    }
    return this.listView;
  }

  private async showNote(nevent: string): Promise<void> {
    const feed = await this.ensureFeed();
    if (!feed) return;
    feed.getElement().remove();
    this.detailView?.destroy();
    const { SingleNoteView } = await import(
      '../components/views/SingleNoteView'
    );
    this.detailView = new SingleNoteView(nevent);
    this.detailEl = this.detailView.getElement();
    this.frame.element.appendChild(this.detailEl);
    this.frame.setBackVisible(true);
    // Keep the classic URL scheme, in place (no view mounting, no history).
    Router.getInstance().replaceUrl(`/note/${nevent}`);
  }

  private showFeed(): void {
    if (!this.listView) return;
    this.detailView?.destroy();
    this.detailView = null;
    this.detailEl = null;
    this.frame.element.appendChild(this.listView.getElement());
    this.frame.setBackVisible(false);
    Router.getInstance().replaceUrl('/timeline');
  }

  pause(): void {
    this.listView?.pause();
  }

  reset(): void {
    if (!this.detailView) return;
    this.detailView.destroy();
    this.detailView = null;
    this.detailEl = null;
    if (this.listView) {
      this.frame.element.appendChild(this.listView.getElement());
    }
    this.frame.setBackVisible(false);
  }

  resume(): void {
    this.listView?.resume();
  }

  destroy(): void {
    this.listView?.destroy();
    this.listView = null;
    this.detailView?.destroy();
    this.detailView = null;
    this.detailEl = null;
    this.frame.destroy();
  }
}

/** Surface factory for the focusDomains registry. */
export const socialSurface = async (): Promise<FocusDomainSurface> => {
  const surface = new SocialSurface();
  return surface.asSurface();
};
