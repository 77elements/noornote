/**
 * ListViewPartial
 * Generic list view component for secondary-content tabs
 *
 * @purpose Provides unified tab + content structure for all list types
 * @used-by MainLayout (for Bookmarks, Follows, Muted Users, Tribes)
 *
 * Architecture:
 * - ListViewPartial provides the container structure (tab + content area)
 * - Individual managers (BookmarkSecondaryManager, FollowListSecondaryManager, MuteListSecondaryManager, TribeSecondaryManager)
 *   render their specific content into the provided container
 */

import { createClosableTab } from '../../../helpers/TabsHelper';

export type ListType = 'bookmarks' | 'follows' | 'mutes' | 'tribes';

export interface ListViewConfig {
  type: ListType;
  title: string; // e.g., "List: Bookmarks"
  onClose: () => void; // Callback when [x] button is clicked
  onRender: (container: HTMLElement) => void; // Callback to render list content
  /**
   * Override the derived tab id (`list-${type}`) used for BOTH the tab button's
   * `data-tab` and the content's `data-tab-content`. Required when a list view
   * must NOT collide with a manager that owns its own `list-${type}` slot —
   * e.g. external (read-only) follows/followers lists must stay distinct from
   * the editable own-follows list so `FollowListManager`'s `list-follows`
   * queries cannot reach them.
   */
  tabContentId?: string;
}

export class ListViewPartial {
  private config: ListViewConfig;
  private tabElement: HTMLElement | null = null;
  private contentElement: HTMLElement | null = null;

  constructor(config: ListViewConfig) {
    this.config = config;
  }

  /**
   * Resolve the tab/content identifier. Honors an explicit `tabContentId`
   * override, otherwise derives `list-${type}`.
   */
  private resolveTabId(): string {
    return this.config.tabContentId ?? `list-${this.config.type}`;
  }

  /**
   * Create tab button with close [x] button using TabsHelper
   */
  public createTab(): HTMLElement {
    const tab = createClosableTab(this.resolveTabId(), this.config.title, () =>
      this.config.onClose()
    );

    this.tabElement = tab;
    return tab;
  }

  /**
   * Create tab content container
   */
  public createContent(): HTMLElement {
    const content = document.createElement('div');
    content.className = 'tab-content';
    content.dataset.tabContent = this.resolveTabId();

    this.contentElement = content;
    return content;
  }

  /**
   * Render list content (delegates to manager)
   */
  public renderContent(): void {
    if (this.contentElement) {
      this.config.onRender(this.contentElement);
    }
  }

  /**
   * Activate this tab
   */
  public activate(): void {
    if (this.tabElement) {
      this.tabElement.classList.add('tab--active');
    }
    if (this.contentElement) {
      this.contentElement.classList.add('tab-content--active');
    }
  }

  /**
   * Deactivate this tab
   */
  public deactivate(): void {
    if (this.tabElement) {
      this.tabElement.classList.remove('tab--active');
    }
    if (this.contentElement) {
      this.contentElement.classList.remove('tab-content--active');
    }
  }

  /**
   * Remove tab and content from DOM
   */
  public destroy(): void {
    this.tabElement?.remove();
    this.contentElement?.remove();
    this.tabElement = null;
    this.contentElement = null;
  }

  /**
   * Get tab element
   */
  public getTab(): HTMLElement | null {
    return this.tabElement;
  }

  /**
   * Get content element
   */
  public getContent(): HTMLElement | null {
    return this.contentElement;
  }

  /**
   * Get list type
   */
  public getType(): ListType {
    return this.config.type;
  }
}
