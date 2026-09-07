/**
 * ListsCountManager
 * Manages the counter on the "Lists" sidebar submenu for Bookmarks:
 * plain total by default, unread/total ratio when the read-sync feature
 * is enabled (see docs/todos/unread-bookmarks.md).
 *
 * @used-by MainLayout
 *
 * Counts are plain localStorage reads (lists/storage readList — light
 * module, no heavy list imports). Updates arrive event-driven: bookmark
 * mutations emit bookmark:updated / bookmark:read, auth changes come via
 * user:login/logout.
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
  private menuElement: HTMLElement;
  private subscriptionIds: string[] = [];

  constructor(menuElement: HTMLElement) {
    this.menuElement = menuElement;
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

    // Bookmarks: the counter IS the unread reminder — one number, counting
    // down with every opened card. Hidden when the read-sync feature is off
    // (a bare total without context confuses), at 0 unread, or logged out.
    const bookmarks = readList<{ id: string }>(StorageKeys.BOOKMARKS, []);
    const readSyncOn =
      loggedIn &&
      PerAccountLocalStorage.getInstance().get<boolean>(
        StorageKeys.BOOKMARKS_READ_SYNC_ENABLED,
        false
      );
    if (bookmarks.length === 0 || !readSyncOn) {
      this.setCount(null);
      return;
    }
    const readMap = PerAccountLocalStorage.getInstance().get<
      Record<string, number>
    >(StorageKeys.BOOKMARKS_READ, {});
    const unread = bookmarks.filter(b => !(b.id in readMap)).length;
    this.setCount(unread > 0 ? `(<strong>${unread}</strong>)` : null);
  }

  private setCount(text: string | null): void {
    const span = this.menuElement.querySelector(
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

  public destroy(): void {
    this.subscriptionIds.forEach(id => this.eventBus.off(id));
    this.subscriptionIds = [];
  }
}
