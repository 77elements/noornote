/**
 * RailFlyout
 * Floating submenu for the collapsed sidebar icon rail
 *
 * @purpose When the sidebar is collapsed to its 64px icon rail, accordion
 *          submenus (Lists, Addons) cannot expand inline — the rail hides
 *          them. This helper detaches the existing submenu <ul> into a
 *          fixed-position panel anchored right of the trigger icon (same
 *          approach as the floating New Post dropup menu).
 * @used-by ListsMenuPartial, MainLayout (Addons accordion)
 */

export class RailFlyout {
  private readonly trigger: HTMLElement;
  private readonly submenu: HTMLElement;
  private isOpen = false;

  private readonly onOutsideClick = (e: MouseEvent): void => {
    const target = e.target as Node;
    if (!this.submenu.contains(target) && !this.trigger.contains(target)) {
      this.close();
    }
  };

  // A resize invalidates the fixed anchor; close to avoid a stale layer.
  private readonly onResize = (): void => this.close();

  constructor(trigger: HTMLElement, submenu: HTMLElement) {
    this.trigger = trigger;
    this.submenu = submenu;
  }

  /**
   * True when the sidebar is the collapsed icon rail (not the phone drawer).
   */
  public static isRailCollapsed(): boolean {
    return (
      document.documentElement.classList.contains('sidebar-collapsed') &&
      !document.documentElement.classList.contains('layout--phone')
    );
  }

  /**
   * Call from the accordion trigger's click handler.
   * Returns true when the click was handled as a flyout toggle (rail mode);
   * false when the caller should run its normal inline-accordion toggle.
   */
  public handleTriggerClick(): boolean {
    if (!RailFlyout.isRailCollapsed()) {
      this.close();
      return false;
    }
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
    return true;
  }

  public close(): void {
    if (!this.isOpen) return;
    this.submenu.classList.remove('primary-nav__submenu--floating');
    this.submenu.style.left = '';
    this.submenu.style.top = '';
    document.removeEventListener('click', this.onOutsideClick);
    window.removeEventListener('resize', this.onResize);
    this.isOpen = false;
  }

  public destroy(): void {
    this.close();
  }

  private open(): void {
    const rect = this.trigger.getBoundingClientRect();
    this.submenu.classList.add('primary-nav__submenu--floating');
    this.submenu.style.left = `${rect.right + 8}px`;
    this.submenu.style.top = `${rect.top}px`;

    // Clamp to the viewport bottom so long lists (Addons) stay fully visible.
    const overflow =
      this.submenu.getBoundingClientRect().bottom - (window.innerHeight - 8);
    if (overflow > 0) {
      this.submenu.style.top = `${Math.max(8, rect.top - overflow)}px`;
    }

    document.addEventListener('click', this.onOutsideClick);
    window.addEventListener('resize', this.onResize);
    this.isOpen = true;
  }
}
