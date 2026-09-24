/**
 * ListsCountManager
 * Manages the bookmark unread indicator in BOTH nav modes and on /lists:
 * - classic accordion submenu: "(N)" text on the Bookmarks sublink
 * - nav wheel: green diode on the Lists item
 * - lists overview page: green diode on the Bookmarks tile
 * (diode look = same .notifications-badge chrome as Notifications/DMs)
 *
 * @used-by MainLayout
 *
 * Counts are plain localStorage reads (lists/storage readList — light
 * module, no heavy list imports). Updates arrive event-driven: bookmark
 * mutations emit bookmark:updated / bookmark:read, auth changes come via
 * user:login/logout, and entering /lists re-syncs its fresh tile.
 *
 * Unread semantics per docs/todos/unread-bookmarks.md: the indicator exists
 * ONLY while the read-sync feature toggle is on (hidden otherwise), counts
 * down per opened card, hidden at 0.
 */

import { TypedEventBus } from '../../../core/TypedEventBus';
import { AuthService } from '../../../services/AuthService';
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../../services/PerAccountLocalStorage';
import { readList } from '../../../lists/storage';

export class ListsCountManager {
  private eventBus: TypedEventBus;
  private authService: AuthService;
  private scopeElement: HTMLElement;
  private subscriptionIds: string[] = [];

  constructor(scopeElement: HTMLElement) {
    this.scopeElement = scopeElement;
    this.eventBus = TypedEventBus.getInstance();
    this.authService = AuthService.getInstance();

    this.subscriptionIds.push(
      this.eventBus.on('bookmark:updated', () => void this.updateCounts()),
      this.eventBus.on('bookmark:read', () => void this.updateCounts()),
      this.eventBus.on('user:login', () => void this.updateCounts()),
      this.eventBus.on('user:logout', () => void this.updateCounts())
    );

    void this.updateCounts();
  }

  public async updateCounts(): Promise<void> {
    const loggedIn = !!this.authService.getCurrentUser();

    const bookmarks = readList<{ id: string }>(StorageKeys.BOOKMARKS, []);
    const readSyncOn =
      loggedIn &&
      PerAccountLocalStorage.getInstance().get<boolean>(
        StorageKeys.BOOKMARKS_READ_SYNC_ENABLED,
        false
      );

    let unread = 0;
    if (readSyncOn && bookmarks.length > 0) {
      const readMap = PerAccountLocalStorage.getInstance().get<
        Record<string, number>
      >(StorageKeys.BOOKMARKS_READ, {});
      unread = bookmarks.filter(b => !(b.id in readMap)).length;
    }

    // Classic submenu: "(N)" reminder text, bold when unread (hidden at 0 —
    // a bare total without context confuses, user feedback 2026-09-06).
    this.setSubmenuCount(unread > 0 ? `(<strong>${unread}</strong>)` : null);

    // Diodes (wheel Lists item + /lists Bookmarks tile): plain number.
    this.setDiodeCount(unread);
  }

  private setSubmenuCount(text: string | null): void {
    const span = this.scopeElement.querySelector(
      '[data-list-count="bookmarks"]'
    ) as HTMLElement | null;
    if (!span) return;
    if (!text) {
      span.style.display = 'none';
      return;
    }
    // Counts are numbers assembled here — no user input, innerHTML is safe.
    span.innerHTML = text;
    span.style.display = '';
  }

  private setDiodeCount(unread: number): void {
    const diodes = this.scopeElement.querySelectorAll<HTMLElement>(
      '[data-list-unread="bookmarks"]'
    );
    diodes.forEach(diode => {
      if (unread > 0) {
        diode.textContent = String(unread);
        diode.style.display = 'inline-flex';
      } else {
        diode.textContent = '';
        diode.style.display = 'none';
      }
    });
  }

  public destroy(): void {
    this.subscriptionIds.forEach(id => this.eventBus.off(id));
    this.subscriptionIds = [];
  }
}
