// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression test for the /lists Bookmarks-tile diode bug: the unread diode
 * on the freshly-mounted tile stayed empty because the only re-sync hook ran
 * on router:view-changed — which fires BEFORE the async view factory appends
 * the tile DOM. The fix is the post-mount contract: ListsOverviewView.resume()
 * (called by ViewMountingService after appendChild) must emit
 * 'lists:overview-mounted', the moment ListsCountManager re-syncs the diode.
 */

vi.mock('../../addons/bookmarks/index', () => ({
  isBookmarksEnabled: () => true,
  isReadSyncEnabled: () => false,
}));
vi.mock('../../addons/tribes/index', () => ({ isTribesEnabled: () => false }));
// Cut the service import chain (AuthService → PerAccountListStorageMigration →
// lists/bookmarks → lists/file → PlatformService module-eval cycle) — same
// pattern as FollowCheckService.test.ts.
vi.mock('../../services/PerAccountListStorageMigration', () => ({
  PerAccountListStorageMigration: class {},
}));

import { ListsOverviewView } from './ListsOverviewView';
import { TypedEventBus } from '../../core/TypedEventBus';

describe('ListsOverviewView — lists:overview-mounted contract', () => {
  beforeEach(() => {
    new ListsOverviewView().destroy();
  });

  it('emits lists:overview-mounted on resume() — after the tiles are in the DOM', () => {
    const bus = TypedEventBus.getInstance();
    const view = new ListsOverviewView();
    // Mount the container so resume() fires with tiles in the DOM, like
    // ViewMountingService does (appendChild → onViewMount → resume).
    document.body.appendChild(view.getElement());

    let fired = false;
    const sub = bus.on('lists:overview-mounted', () => {
      fired = true;
    });

    view.resume();
    bus.off(sub);

    expect(fired).toBe(true);
    // The tile grid with the bookmarks diode span must exist by now — this
    // is the span ListsCountManager paints into on the event.
    const diode = view
      .getElement()
      .querySelector('[data-list-unread="bookmarks"]');
    expect(diode !== null).toBe(true);

    view.destroy();
  });
});
