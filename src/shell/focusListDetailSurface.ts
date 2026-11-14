/**
 * Focus surface base: list ↔ detail (v2).
 *
 * The shared behavior behind every focus domain whose content is "a
 * cached list view; clicking an entry swaps a detail view into the
 * column; back returns to the list" (articles, social — future domains
 * follow the field-tested shape: videos, recipes, …). A domain surface
 * only provides config: view factories, the navigation seam's view
 * type, and the URL routes.
 *
 * Element lifecycle is owned by the FocusSurfaceFrame — views' destroy()
 * methods do not detach their elements, so the frame is the single place
 * that guarantees exactly one content element in the column (a leftover
 * detail would push the list down → phantom gap above the first card).
 */

import type {
  FocusDomainSurface,
  FocusDomainSurfaceView,
} from './focusDomains';
import {
  createFocusSurfaceFrame,
  type FocusSurfaceFrame,
} from './focusSurfaceFrame';
import { Router } from '../services/Router';

/** Minimal shape every surface view already fulfills. */
export interface SurfaceViewHandle {
  getElement(): HTMLElement;
  destroy(): void;
}

export interface FocusListDetailSurfaceConfig {
  /** Frame class name (e.g. 'focus-surface--articles'). */
  className: string;
  /** View type this surface owns in the focus navigation seam. */
  navViewType: string;
  /** URL route while the list is shown. */
  listRoute: string;
  /** URL route while a detail is shown. */
  detailRoute: (param: string) => string;
  /** Create the cached list view (called once, lazily). */
  createList: () => Promise<SurfaceViewHandle>;
  /** Create the detail view for a focus-navigation param. */
  createDetail: (param: string) => Promise<SurfaceViewHandle>;
  /**
   * Save/restore the column scroll around detail swaps — for list views
   * that do NOT manage their own internal scrolling (the column scrolls).
   * Views with internal scroll (social timeline) leave this off.
   */
  preserveListScroll?: boolean;
}

export class FocusListDetailSurface implements FocusDomainSurfaceView {
  protected frame: FocusSurfaceFrame;
  private list: SurfaceViewHandle | null = null;
  /** The constructor's pending list creation (awaited by openDetail). */
  private listPromise: Promise<void> | null = null;
  private detail: SurfaceViewHandle | null = null;
  /** The param of the detail currently shown (null = list state). */
  private detailParam: string | null = null;
  private savedListScroll = 0;

  /** The focus column's scroll container (the stage's surface slot). */
  protected get scrollSlot(): HTMLElement | null {
    return this.frame.element.parentElement as HTMLElement | null;
  }

  constructor(private readonly config: FocusListDetailSurfaceConfig) {
    this.frame = createFocusSurfaceFrame(config.className, () =>
      this.showList()
    );
    // List mounts immediately — the surface IS the domain's content.
    this.listPromise = config.createList().then(list => {
      this.list = list;
      this.frame.swapToList(list.getElement());
    });
  }

  /** The surface contract: this object doubles as the view handle. */
  asSurface(): FocusDomainSurface {
    return { element: this.frame.element, view: this };
  }

  /**
   * Focus navigation seam: render a detail in-column. Returns false for
   * view types this surface does not own (falls through to the classic
   * navigation).
   */
  handleFocusNav(viewType: string, param?: string): boolean {
    if (viewType !== this.config.navViewType || !param) return false;
    void this.openDetail(param);
    return true;
  }

  /**
   * Open a detail view in the column (also the entry for list-view click
   * callbacks wired in the config's createList factory).
   */
  async openDetail(param: string): Promise<void> {
    // A cross-object handoff can open a detail right after the surface
    // was created — await the constructor's pending list creation so the
    // list is never created twice and its late swapToList cannot clobber
    // the detail swap below.
    if (this.listPromise) await this.listPromise;
    if (!this.list) this.list = await this.config.createList();
    // Save the list's column scroll before the swap collapses the
    // scrollable area (restored on back / list return).
    if (this.config.preserveListScroll) {
      this.savedListScroll = this.scrollSlot?.scrollTop ?? 0;
    }
    this.detail?.destroy();
    this.detail = await this.config.createDetail(param);
    this.detailParam = param;
    this.frame.swapToDetail(this.detail.getElement());
    if (this.config.preserveListScroll && this.scrollSlot) {
      this.scrollSlot.scrollTop = 0;
    }
    this.frame.setBackVisible(true);
    // Keep the classic URL scheme, in place (no view mounting, no history).
    Router.getInstance().replaceUrl(this.config.detailRoute(param));
  }

  private showList(): void {
    if (!this.list) return;
    this.detail?.destroy();
    this.detail = null;
    this.detailParam = null;
    this.frame.swapToList(this.list.getElement());
    if (this.config.preserveListScroll && this.scrollSlot) {
      this.scrollSlot.scrollTop = this.savedListScroll;
    }
    this.frame.setBackVisible(false);
    Router.getInstance().replaceUrl(this.config.listRoute);
  }

  /** Return to the list state when the surface is detached from its column. */
  reset(): void {
    if (!this.detail) return;
    this.detail.destroy();
    this.detail = null;
    this.detailParam = null;
    if (this.list) {
      this.frame.swapToList(this.list.getElement());
      if (this.config.preserveListScroll && this.scrollSlot) {
        this.scrollSlot.scrollTop = this.savedListScroll;
      }
    }
    this.frame.setBackVisible(false);
  }

  back(): void {
    this.showList();
  }

  /** Sync the URL with the current state (a preserved detail keeps its route). */
  syncUrl(): void {
    Router.getInstance().replaceUrl(
      this.detail && this.detailParam
        ? this.config.detailRoute(this.detailParam)
        : this.config.listRoute
    );
  }

  pause(): void {
    (this.list as { pause?: () => void } | null)?.pause?.();
  }

  resume(): void {
    (this.list as { resume?: () => void } | null)?.resume?.();
  }

  destroy(): void {
    this.list?.destroy();
    this.list = null;
    this.detail?.destroy();
    this.detail = null;
    this.frame.destroy();
  }
}
