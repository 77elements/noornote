/**
 * Focus Stage (v2) — builds the FS grid of primary domain circles inside
 * #focus-stage and owns the unified morph logic: clicking a circle grows
 * it into the center column (600px surface + actions rail), the other
 * circles shift aside, the
 * domain surface mounts BEFORE the morph — document flow: the column
 * height is its content height, so the FLIP animates to the laid-out
 * final geometry. The close control reverses the morph and restores the
 * grid.
 *
 * Morph technique: FLIP on the real elements via the Web Animations API.
 * The grid switches to `1fr calc(600px + $gap + 30px) 1fr` and every object animates from its
 * previous geometry to the new one — top-left-anchored translate for the
 * position delta, px-animated width/height for size changes (no scale, so
 * the 2px border stays 2px; animated height is capped at the viewport
 * bottom — the beyond-fold rest snaps invisibly after the animation), and
 * border-radius 50% → column radius only on the active object.
 * `prefers-reduced-motion` skips the animation.
 *
 * Under the morph breakpoint (1100px) there is no FLIP: a simple full-
 * width column takeover (mobile behavior).
 *
 * Only one domain can be focused at a time (PoC). Surfaces are cached per
 * domain: closing pauses the view, reopening re-mounts and resumes it.
 */

import { _ } from '../i18n';
import { Tooltip } from '../components/ui/Tooltip';
import { Switch } from '../components/ui/Switch';
import { Router } from '../services/Router';
import { NavigationDispatcher } from '../services/NavigationDispatcher';
import { AddonLoader, type AddonRuntime } from '../addons/AddonLoader';
import { TypedEventBus } from '../core/TypedEventBus';
import {
  isLiveStreamsSidebarWidget,
  hasLiveStreamsBackgroundPin,
  isLiveStreamsEnabled,
} from '../addons/live-streams/index';
import { getNostrMajlisSettings } from '../addons/nostr-majlis/index';
import {
  isBtcPriceEnabled,
  isBtcPriceSidebarWidget,
} from '../addons/btc-price/index';
import { isWalletBalanceEnabled } from '../addons/wallet-balance/index';
import { parseFocusUrl, type FocusUrlState } from './focusUrlState';
import { isSelfNav, pushFocusUrl } from './focusHistorySync';
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../services/PerAccountLocalStorage';
import { NotificationsBadgeManager } from '../components/layout/managers/NotificationsBadgeManager';
import { DMBadgeManager } from '../components/layout/managers/DMBadgeManager';
import { ListsCountManager } from '../components/layout/managers/ListsCountManager';
import {
  FOCUS_DOMAINS,
  type FocusDomainDef,
  type FocusDomainSurface,
  type FocusSettingsDrawer,
  type FocusSettingsView,
} from './focusDomains';
import { loadHiddenObjectIds, hideObject } from './hiddenObjectsStore';
import { diagLog } from '../services/DiagnosticLogger';
import { NnDropdown } from '../components/ui/NnDropdown';
import {
  FOCUS_OBJECT_SETS,
  applyObjectSet,
  matchingObjectSet,
} from './focusObjectSets';
import { canHideObject } from './focusDependencyGraph';
import { reportDependencyError } from './dependencyError';
import {
  DETACHED_DETAILS,
  type DetachedDetailComponent,
} from './detachedDetails';
import { HiddenFeaturesPanel } from './hiddenFeaturesPanel';
import { FocusLogPanel } from './focusLogPanel';
import { applyDomainShutdown } from './domainShutdown';

/** URL of the home grid (no domain focused). */
const HOME_ROUTE = '/';

/** Morph duration/easing — single source for open and close. */
const MORPH_MS = 380;
const MORPH_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)';
/** Below this viewport width: column takeover instead of FLIP morph. */
const MORPH_MIN_WIDTH = 1100;
/** Media query mirroring the SCSS takeover breakpoint (must stay in sync). */
const MORPH_MIN_QUERY = `(max-width: ${MORPH_MIN_WIDTH - 1}px)`;
/** Column scrolled this far → the scroll-to-top action appears (v1 parity). */
const SCROLL_TOP_THRESHOLD = 100;

/**
 * Widgets mounted into the FV side stacks (v2). Only ids listed here get
 * a slot; the widget instance comes from the addon runtime (structural
 * contract, see FocusWidgetLike).
 */
const WIDGET_IDS = [
  'live-streams',
  'live-streams-mini-player',
  'nostr-majlis',
  'nostr-majlis-quran',
  'btc-price',
  'wallet-balance',
] as const;

/** Structural widget contract for the FV side-stack slots (v2). */
interface FocusWidgetLike {
  setFocusHost(host: HTMLElement | null): void;
}

/** A view type handed across objects: open this detail in the new column.
 *  param is optional — param-less view types (e.g. the composer) route to
 *  the target surface's secondary detail. */
interface FocusHandoff {
  viewType: string;
  param?: string;
}

/**
 * Unread diodes on the circles (v1 nn-wheel parity): notifications, DMs
 * and unread bookmarks. Same badge classes + SAME badge managers as the
 * classic nav drive them (wired in mount), shown whenever unread exists —
 * always rendered, no hover gating like the move handle.
 */
const DIODES: Record<string, string> = {
  notifications:
    '<span class="notifications-badge focus-object__diode" data-focus-diode="notifications"></span>',
  messages:
    '<span class="badge badge--green dm-badge focus-object__diode" data-focus-diode="dm" style="display: none"></span>',
  bookmarks:
    '<span class="notifications-badge focus-object__diode" data-focus-diode="bookmarks" data-list-unread="bookmarks"></span>',
};

export class FocusStage {
  private root: HTMLElement;
  private grid!: HTMLElement;
  private objects = new Map<string, HTMLElement>();
  private surfaces = new Map<string, FocusDomainSurface>();
  /**
   * Circle order — registry order by default, user-adjustable via drag &
   * drop on the circles' move handles (drop on another circle SWAPS the
   * two positions), persisted per account. Drives the grid DOM order and
   * the side-stack distribution (see reparentSideStacks).
   */
  private order: string[] = [];
  /**
   * Circle arrangement in the focused layout (FV), explicit per-column
   * positions. null = alternating distribution derived from the SV order.
   * Independent of `order` (SV grid) — FV drags never touch the SV.
   * Persisted per account (FOCUS_UI_COLUMN_LAYOUT); later secondary
   * objects (widgets) join the same lists.
   */
  private columnLayout: { left: string[]; right: string[] } | null =
    this.loadColumnLayout();
  /**
   * Widget placement in the focused layout (FV): { [widgetId]: { side,
   * index } }, index into the side stack's item flow (0 = above all
   * circles). Unlisted widgets render at the default spot (right stack,
   * top). Persisted per account (FOCUS_UI_WIDGET_LAYOUT); set by drag &
   * drop on the widgets' move handles. Separate from columnLayout —
   * domain ids collide with widget ids ('live-streams' is both).
   */
  private widgetLayout: Record<
    string,
    { side: 'left' | 'right'; index: number }
  > = this.loadWidgetLayout();
  /** Widget hosts currently mounted in the side stacks (see placeWidgets). */
  private widgetHosts = new Map<
    string,
    { widget: FocusWidgetLike; host: HTMLElement }
  >();
  /** Unread-diode drivers (v1 badge managers over the shell's diodes). */
  private badgeManagers: Array<{
    destroy(): void;
  }> = [];
  /**
   * Hidden object ids (user-hideable circles, docs/todos/hidden-objects.md).
   * Hidden circles are absent from the grid, their code fully unloaded
   * (surfaces destroyed, widgets removed). Fresh ids arrive via the
   * 'focus:objects-hidden-changed' subscription (live grid update).
   */
  private hiddenIds: string[] = [];
  /** Side stacks render their circles as compact chips (the stack tools'
   * compact toggle). Per-account view preference; the active circle and
   * the home grid always render round. */
  private stackCompact = false;
  /** Top-bar "Arrange positions" gate (default OFF): while OFF the layout
   * satellites (circle move/hide, stack tools, widget move) render hidden
   * — the shell stays calm for users who never rearrange. Diodes and the
   * active column's actions are exempt (not layout tools). */
  private arrangeOn = false;
  /** focus:objects-hidden-changed subscription (mount → destroy contract). */
  private hiddenSubId: string | null = null;
  /** live-streams:widget-toggle subscription (mount → destroy contract). */
  private widgetToggleSubId: string | null = null;
  /** live-streams:background-player subscription (mini player widget). */
  private pinSubId: string | null = null;
  /** nostr-majlis:settings-changed subscription (majlis widgets). */
  private majlisSettingsSubId: string | null = null;
  /** btc-price:widget-toggle subscription (btc price widget). */
  private btcWidgetSubId: string | null = null;
  /** wallet-balance:addon-toggle subscription (wallet display widget). */
  private walletSubId: string | null = null;
  /** Tooltip disposers for the persistent 30px controls (destroy contract). */
  private tooltipDisposers: Array<() => void> = [];
  /** Side stacks while a domain is focused (see reparentSideStacks). */
  private sideStacks: [HTMLElement, HTMLElement] | null = null;
  private activeId: string | null = null;
  private morphing = false;
  /** Per-object scroll-to-top action state (button + last scroll source). */
  private scrollTopState = new Map<
    string,
    { btn: HTMLElement; source: HTMLElement | null }
  >();
  /** History sync: back/forward re-derive shell state from the URL. */
  private readonly onRouterHistoryChanged = (): void => {
    if (isSelfNav()) return;
    void this.syncFromUrl(Router.getInstance().getCurrentPath());
  };
  /** ED-b bottom drawer (object settings), injected by the shell. */
  private drawer: FocusSettingsDrawer | null = null;
  private settingsView: FocusSettingsView | null = null;
  private settingsDef: FocusDomainDef | null = null;
  private settingsHost: HTMLElement | null = null;
  /** True while the panel came from the surface's secondary detail. */
  private settingsFromSecondary = false;
  /** Hidden Features panel (tab-open ED-b) — mount/destroy contract. */
  private hiddenPanelView: HiddenFeaturesPanel | null = null;
  private hiddenPanelHost: HTMLElement | null = null;
  /** Top-bar object-set selector (destroy contract: NnDropdown portals
   * its menu to <body> — must be torn down with the stage). */
  private setDropdown: NnDropdown | null = null;
  /** Flattened system-log panel (tab-open ED-b in a FV) — same contract. */
  private logPanelView: FocusLogPanel | null = null;
  private logPanelHost: HTMLElement | null = null;
  /**
   * Detached detail (Phase 5): a hidden owner's detail component rendered
   * directly in the active column — without the owner object. The stashed
   * frame content + back-button state restore on close (syncFromUrl of
   * the detail route, or a new seam nav).
   */
  private detached: {
    component: DetachedDetailComponent;
    activeEl: HTMLElement;
    stash: HTMLElement | null;
    backWasHidden: boolean;
  } | null = null;
  private lastWidth = window.innerWidth;
  private onResize = (): void => {
    const width = window.innerWidth;
    if (width === this.lastWidth) return;
    this.lastWidth = width;
    // Height-only resizes (devtools docked bottom, window grow) must keep
    // the focused column — only WIDTH changes matter for the layout mode.
    if (!this.activeId || this.morphing) return;
    const def = FOCUS_DOMAINS.find(d => d.id === this.activeId);
    const el = def ? this.objects.get(def.id) : undefined;
    if (!def || !el) return;
    const takeOver = window.matchMedia(MORPH_MIN_QUERY).matches;
    if (takeOver) {
      // Crossed DOWN into takeover: drop the FLIP artifacts (inline
      // placement, side stacks) — the takeover CSS holds the column alone.
      el.style.gridColumn = '';
      this.restoreSideCircles();
    } else if (!this.sideStacks) {
      // Crossed UP into FLIP mode: re-place the column and re-parent the
      // side stacks (takeover left the circles flat in the grid).
      el.style.gridColumn = '2';
      this.reparentSideStacks(def.id);
    }
    // Same-mode width changes: pure CSS reflow, nothing to do.
  };

  constructor(root: HTMLElement) {
    this.root = root;
    window.addEventListener(
      'router:history-changed',
      this.onRouterHistoryChanged
    );
    if (import.meta.env.DEV) {
      // Dev load monitor: report the cached surfaces + active object.
      // (Shell → services import is allowed; prod builds drop this block.)
      void import('../services/DevLoadMonitor').then(
        ({ registerDevLoadSection }) =>
          registerDevLoadSection('v2-stage', () => ({
            active: this.activeId,
            cachedSurfaces: Array.from(this.surfaces.keys()),
            widgetHosts: Array.from(this.widgetHosts.keys()),
          }))
      );
    }
  }

  /** Build the FS grid into the stage element. */
  mount(): void {
    // SV top bar: permanent header row above the grid (placeholder for
    // future controls). Today it holds the v1 switch (injected by the
    // shell into the slot — it used to live in the ED-t panel, whose tab
    // covered the top circles) and the load-resource-monitor button.
    const topBar = document.createElement('div');
    topBar.className = 'top-bar';
    topBar.innerHTML = `
      <div class="top-bar__switch" data-sv-v1-switch-slot></div>
      <div class="top-bar__arrange" data-sv-arrange-slot></div>
      <button type="button" class="top-bar__loadmon" data-sv-loadmon aria-label="${_('Load Resource Monitor')}">
        <svg width="18" height="18" aria-hidden="true"><use href="#icon-trending-up"/></svg>
      </button>
      <a href="#" class="top-bar__reset-order" data-sv-reset-order>${_('Restore default order')}</a>
    `;
    // Object-set selector: named bundles of visible objects, applied in
    // one step (everything not in the set is hidden — the same save →
    // event → shutdown-diff path as the per-object hide button). The
    // trigger label shows the active set; a custom mixed state shows the
    // neutral placeholder.
    const setOptions = [
      { value: '', label: _('Workspace') },
      ...FOCUS_OBJECT_SETS.map(set => ({ value: set.id, label: set.label })),
    ];
    this.setDropdown = new NnDropdown({
      options: setOptions,
      selectedValue: matchingObjectSet(loadHiddenObjectIds())?.id ?? '',
      onChange: value => {
        if (!value) {
          this.syncObjectSetDropdown();
          return;
        }
        applyObjectSet(value);
      },
      className: 'top-bar__set',
    });
    const setDropdownEl = this.setDropdown.getElement();
    // Arrange-positions gate: the layout satellites render only while the
    // switch is ON (persisted per account, default OFF).
    this.arrangeOn =
      PerAccountLocalStorage.getInstance().get<boolean>(
        StorageKeys.FOCUS_UI_ARRANGE_POSITIONS,
        false
      ) === true;
    this.applyArrangeGate();
    const arrangeSwitch = new Switch({
      label: _('Arrange positions'),
      checked: this.arrangeOn,
      onChange: checked => {
        this.arrangeOn = checked;
        PerAccountLocalStorage.getInstance().set(
          StorageKeys.FOCUS_UI_ARRANGE_POSITIONS,
          checked
        );
        this.applyArrangeGate();
        diagLog('system', 'focus_arrange_positions_toggled', { on: checked });
      },
    });
    const arrangeWrap = topBar.querySelector(
      '[data-sv-arrange-slot]'
    ) as HTMLElement;
    arrangeWrap.innerHTML = arrangeSwitch.render();
    arrangeSwitch.setupEventListeners(arrangeWrap);
    const loadmonBtn = topBar.querySelector('[data-sv-loadmon]') as HTMLElement;
    topBar.insertBefore(setDropdownEl, loadmonBtn);
    loadmonBtn.addEventListener('click', () => {
      // Same boot-path discipline as the typed trigger: dynamic import.
      void import('./loadHud').then(m => m.openLoadHud());
    });
    this.tooltipDisposers.push(
      Tooltip.attach(loadmonBtn, _('Load Resource Monitor'), {
        placement: 'bottom',
      })
    );
    // "Restore default order": drop the persisted circle order — the next
    // loadOrder() falls back to the registry order — and mirror it into
    // the grid (no-op while an object is active or morphing, same guard
    // as swapOrder).
    const resetOrderLink = topBar.querySelector(
      '[data-sv-reset-order]'
    ) as HTMLAnchorElement;
    resetOrderLink.addEventListener('click', e => {
      e.preventDefault();
      PerAccountLocalStorage.getInstance().remove(StorageKeys.FOCUS_UI_ORDER);
      this.order = this.loadOrder();
      this.applyOrderToGrid();
    });
    this.root.appendChild(topBar);

    this.grid = document.createElement('div');
    this.grid.className = 'focus-stage__grid';
    this.order = this.loadOrder();
    this.hiddenIds = loadHiddenObjectIds();
    this.stackCompact =
      PerAccountLocalStorage.getInstance().get<boolean>(
        StorageKeys.FOCUS_UI_STACK_COMPACT,
        false
      ) === true;
    for (const id of this.order) {
      if (this.hiddenIds.includes(id)) continue;
      const def = FOCUS_DOMAINS.find(d => d.id === id);
      if (def) this.grid.appendChild(this.createObject(def));
    }
    this.root.appendChild(this.grid);
    window.addEventListener('resize', this.onResize);
    // Hidden set changed (a circle was hidden via its hide button or
    // restored from the ED-b panel): apply the delta to the live grid.
    this.hiddenSubId = TypedEventBus.getInstance().on(
      'focus:objects-hidden-changed',
      data => this.onObjectsHiddenChanged(data?.hidden ?? [])
    );
    // "Show Live Streams Widget" toggled in the addon object: place (or
    // remove) the widget live while stacks exist — next focus would
    // otherwise only pick the new setting up.
    this.widgetToggleSubId = TypedEventBus.getInstance().on(
      'live-streams:widget-toggle',
      data => this.onWidgetToggle(!!data?.enabled)
    );
    // Background pin gained/lost: the mini player widget appears/disappears
    // live (its only enable condition — independent of any setting).
    this.pinSubId = TypedEventBus.getInstance().on(
      'live-streams:background-player',
      data => {
        this.setWidgetAvailable('live-streams-mini-player', !!data?.pinned);
      }
    );
    // A majlis widget switch flipped in the addon object: re-evaluate
    // BOTH majlis widgets live (the flipped one appears/disappears, the
    // other just re-renders — same re-evaluation, no per-widget branch).
    this.majlisSettingsSubId = TypedEventBus.getInstance().on(
      'nostr-majlis:settings-changed',
      () => {
        const settings = getNostrMajlisSettings();
        this.setWidgetAvailable('nostr-majlis', settings.sidebarWidget);
        this.setWidgetAvailable('nostr-majlis-quran', settings.quranDaily);
      }
    );
    // The "Show BTC Sidebar Widget" switch flipped in the addon object.
    this.btcWidgetSubId = TypedEventBus.getInstance().on(
      'btc-price:widget-toggle',
      data => this.setWidgetAvailable('btc-price', !!data?.enabled)
    );
    // The wallet addon toggled: the display appears/disappears live
    // (its only enable condition — same as classic).
    this.walletSubId = TypedEventBus.getInstance().on(
      'wallet-balance:addon-toggle',
      data => this.setWidgetAvailable('wallet-balance', !!data?.enabled)
    );
    this.setupBadgeManagers();
  }

  /**
   * Wire the SAME badge managers the classic nav uses to the shell's
   * diode spans (notifications / DMs / unread bookmarks). Scoped to the
   * grid; destroyed on shell unmount.
   */
  private setupBadgeManagers(): void {
    const notif = this.grid.querySelector(
      '[data-focus-diode="notifications"]:not([data-list-unread])'
    ) as HTMLElement | null;
    const dm = this.grid.querySelector(
      '[data-focus-diode="dm"]'
    ) as HTMLElement | null;
    if (notif) this.badgeManagers.push(new NotificationsBadgeManager(notif));
    if (dm) this.badgeManagers.push(new DMBadgeManager(dm));
    this.badgeManagers.push(new ListsCountManager(this.grid));
  }

  /**
   * Open a hidden owner's detail component in the ACTIVE column (Phase
   * 5 seam fallback): the surface's current content is stashed (never
   * destroyed — the surface owns it), the detail element takes the slot,
   * the back action is armed and the history follows the owner's detail
   * route — so the global back button unwinds the detached state via
   * syncFromUrl (which restores the stash instead of navigating).
   */
  private async openDetachedDetail(
    viewType: string,
    param?: string
  ): Promise<void> {
    const factory = DETACHED_DETAILS[viewType];
    const activeId = this.activeId;
    const activeEl = activeId ? this.objects.get(activeId) : null;
    if (!factory || !activeId || !activeEl) return;
    const component = await factory(param);
    // A detached detail already open: unwind it first (back to the
    // stashed content), then swap — a quoted-note click inside the open
    // SNV replaces the detail, it never stacks.
    if (this.detached) this.closeDetachedDetail();
    // The morph may have closed meanwhile — don't orphan the component.
    if (this.activeId !== activeId) {
      component.destroy();
      return;
    }
    const slot = activeEl.querySelector('[data-focus-slot]') as HTMLElement;
    const backBtn = activeEl.querySelector(
      "[data-focus-action='back']"
    ) as HTMLElement | null;
    const scrollTop = this.scrollTopState.get(activeId);
    this.detached = {
      component,
      activeEl,
      stash: (slot.firstElementChild as HTMLElement) ?? null,
      backWasHidden: backBtn?.hidden ?? true,
    };
    slot.replaceChildren(component.el);
    if (scrollTop) scrollTop.btn.hidden = true;
    if (backBtn) backBtn.hidden = false;
    // History follows the owner's detail route — back unwinds via
    // syncFromUrl. Routes mirror the owner surfaces' detailRoute shapes.
    const route =
      viewType === 'article' ? `/article/${param}` : `/note/${param}`;
    pushFocusUrl(route);
  }

  /** Tear the detached detail down and restore the stashed column content. */
  private closeDetachedDetail(): void {
    const d = this.detached;
    if (!d) return;
    this.detached = null;
    d.component.destroy();
    const slot = d.activeEl.querySelector('[data-focus-slot]') as HTMLElement;
    if (d.stash) slot.replaceChildren(d.stash);
    const backBtn = d.activeEl.querySelector(
      "[data-focus-action='back']"
    ) as HTMLElement | null;
    if (backBtn) backBtn.hidden = d.backWasHidden;
  }

  /**
   * Widget ids (FV side-stack widgets) contributed by a domain — hiding
   * the domain removes its widgets (RAM principle); widgetFor additionally
   * refuses to ensure-load runtimes for hidden domains.
   */
  private static readonly WIDGETS_BY_DOMAIN: Record<string, string[]> = {
    'live-streams': ['live-streams', 'live-streams-mini-player'],
    majlis: ['nostr-majlis', 'nostr-majlis-quran'],
    'btc-price': ['btc-price'],
    'wallet-balance': ['wallet-balance'],
  };

  /**
   * Hidden set changed: apply the delta to the live grid. Hide = circle
   * removed + its surface destroyed and evicted (RAM principle: the
   * object's code is fully unloaded — a fresh surface is created lazily
   * on unhide). Unhide = circle re-created at its stored order position.
   * In the FOCUSED layout the side stacks are rebuilt; in the home grid
   * the DOM order is re-mirrored. Badge managers re-attach when the
   * membership changed (their diodes may have entered/left the grid).
   */
  private onObjectsHiddenChanged(hidden: string[]): void {
    const previous = this.hiddenIds;
    this.hiddenIds = hidden;
    // RAM principle (Phase 4): newly hidden addon domains are switched
    // OFF entirely (runtime destroyed), unhidden ones re-enabled — same
    // code path as the classic settings toggle.
    applyDomainShutdown(previous, hidden);
    this.syncObjectSetDropdown();
    let membershipChanged = false;

    for (const id of hidden) {
      if (previous.includes(id)) continue;
      const el = this.objects.get(id);
      if (!el || id === this.activeId) continue;
      const surface = this.surfaces.get(id);
      if (surface) {
        surface.view?.destroy?.();
        this.surfaces.delete(id);
      }
      this.scrollTopState.delete(id);
      el.remove();
      this.objects.delete(id);
      membershipChanged = true;
      for (const widgetId of FocusStage.WIDGETS_BY_DOMAIN[id] ?? []) {
        this.setWidgetAvailable(widgetId, false);
      }
    }

    for (const id of this.order) {
      if (hidden.includes(id) || this.objects.has(id)) continue;
      const def = FOCUS_DOMAINS.find(d => d.id === id);
      if (!def) continue;
      const circle = this.createObject(def);
      this.objects.set(id, circle);
      // Insert at the stored order position — but only against anchors
      // that are live grid children: in the FOCUSED layout the mounted
      // circles live inside the side stacks (reparentSideStacks), so a
      // blind insertBefore threw NotFoundError on the first mass-apply
      // from the top bar. The post-loop applyOrderToGrid / stack rebuild
      // normalizes the order either way.
      const index = this.order.indexOf(id);
      let anchor: HTMLElement | null = null;
      for (const laterId of this.order.slice(index + 1)) {
        const laterEl = this.objects.get(laterId) ?? null;
        if (laterEl && laterEl.parentElement === this.grid) {
          anchor = laterEl;
          break;
        }
      }
      if (anchor) this.grid.insertBefore(circle, anchor);
      else this.grid.appendChild(circle);
      membershipChanged = true;
    }

    // A requirer got hidden/unhidden — the hide affordances of the
    // remaining circles flip with it.
    for (const [id, el] of this.objects) {
      const btn = el.querySelector(
        "[data-focus-action='hide']"
      ) as HTMLElement | null;
      if (!btn) continue;
      btn.hidden = !canHideObject(
        id,
        FOCUS_DOMAINS.map(d => d.id),
        this.hiddenIds
      );
    }

    if (!membershipChanged) return;

    if (this.sideStacks && this.activeId) {
      // Focused: rebuild the stacks fresh (reparentSideStacks re-runs the
      // distribution + widget placement — widgetFor skips hidden domains).
      for (const stack of this.sideStacks) stack.remove();
      this.sideStacks = null;
      this.reparentSideStacks(this.activeId);
    } else {
      this.applyOrderToGrid();
    }
    // Badge diodes may have entered/left the grid.
    for (const mgr of this.badgeManagers) mgr.destroy();
    this.badgeManagers = [];
    this.setupBadgeManagers();
  }

  /**
   * Re-derive the object-set trigger label from the live hidden set: the
   * active set's name while the state matches it exactly, the neutral
   * placeholder for any custom state (per-object hides, unhide-all).
   */
  private syncObjectSetDropdown(): void {
    if (!this.setDropdown) return;
    this.setDropdown.setValue(matchingObjectSet(this.hiddenIds)?.id ?? '');
  }

  /**
   * The persisted circle order, validated against the registry: stale ids
   * dropped, unknown domains appended in registry order — the array is
   * always a permutation of FOCUS_DOMAINS.
   */
  private loadOrder(): string[] {
    const ids = FOCUS_DOMAINS.map(d => d.id);
    const stored = PerAccountLocalStorage.getInstance().get<string[] | null>(
      StorageKeys.FOCUS_UI_ORDER,
      null
    );
    if (!Array.isArray(stored)) return ids;
    const valid = stored.filter(id => ids.includes(id));
    return [...valid, ...ids.filter(id => !valid.includes(id))];
  }

  /** Registry defs in the user's stored order. */
  private orderedDefs(): FocusDomainDef[] {
    return this.order
      .map(id => FOCUS_DOMAINS.find(d => d.id === id))
      .filter((d): d is FocusDomainDef => !!d);
  }

  /**
   * The persisted FV column layout, validated against the registry: stale
   * ids dropped, duplicates removed, an id listed in BOTH columns kept
   * only in 'left'. Null when nothing (or a broken shape) is stored —
   * callers derive the alternating default.
   */
  private loadColumnLayout(): { left: string[]; right: string[] } | null {
    const ids = FOCUS_DOMAINS.map(d => d.id);
    const stored = PerAccountLocalStorage.getInstance().get<{
      left: string[];
      right: string[];
    } | null>(StorageKeys.FOCUS_UI_COLUMN_LAYOUT, null);
    if (
      !stored ||
      !Array.isArray(stored.left) ||
      !Array.isArray(stored.right)
    ) {
      return null;
    }
    const clean = (list: string[], skip: string[]): string[] => [
      ...new Set(list.filter(id => ids.includes(id) && !skip.includes(id))),
    ];
    const left = clean(stored.left, []);
    const right = clean(stored.right, left);
    if (left.length === 0 && right.length === 0) return null;
    return { left, right };
  }

  /**
   * The persisted FV widget placement, sanitized against WIDGET_IDS:
   * unknown ids dropped, malformed spots fall back to the default,
   * indexes clamped to ≥ 0.
   */
  private loadWidgetLayout(): Record<
    string,
    { side: 'left' | 'right'; index: number }
  > {
    const stored = PerAccountLocalStorage.getInstance().get<Record<
      string,
      { side: 'left' | 'right'; index: number }
    > | null>(StorageKeys.FOCUS_UI_WIDGET_LAYOUT, null);
    if (!stored) return {};
    const clean: Record<string, { side: 'left' | 'right'; index: number }> = {};
    for (const id of WIDGET_IDS) {
      const spot = stored[id];
      if (!spot || (spot.side !== 'left' && spot.side !== 'right')) continue;
      clean[id] = {
        side: spot.side,
        index:
          typeof spot.index === 'number' && Number.isFinite(spot.index)
            ? Math.max(0, Math.floor(spot.index))
            : 0,
      };
    }
    return clean;
  }

  private persistWidgetLayout(): void {
    PerAccountLocalStorage.getInstance().set(
      StorageKeys.FOCUS_UI_WIDGET_LAYOUT,
      this.widgetLayout
    );
  }

  /**
   * The arrangement to render RIGHT NOW: the persisted column layout or,
   * when none is stored, alternating 50/50 — with registry additions since
   * the layout was saved interleaved by their SV position (even index →
   * left), so every circle always has a home and the default derivation
   * stays stable. Always returns fresh arrays (callers mutate the result).
   */
  private effectiveLayout(): { left: string[]; right: string[] } {
    const base = this.columnLayout ?? {
      left: [] as string[],
      right: [] as string[],
    };
    const left = [...base.left];
    const right = [...base.right];
    this.orderedDefs().forEach((def, i) => {
      if (left.includes(def.id) || right.includes(def.id)) return;
      (i % 2 === 0 ? left : right).push(def.id);
    });
    return { left, right };
  }

  /** Full teardown (shell unmount): destroy every cached surface. */
  destroy(): void {
    window.removeEventListener('resize', this.onResize);
    this.setDropdown?.destroy();
    this.setDropdown = null;
    if (this.widgetToggleSubId) {
      TypedEventBus.getInstance().off(this.widgetToggleSubId);
      this.widgetToggleSubId = null;
    }
    if (this.pinSubId) {
      TypedEventBus.getInstance().off(this.pinSubId);
      this.pinSubId = null;
    }
    if (this.majlisSettingsSubId) {
      TypedEventBus.getInstance().off(this.majlisSettingsSubId);
      this.majlisSettingsSubId = null;
    }
    if (this.btcWidgetSubId) {
      TypedEventBus.getInstance().off(this.btcWidgetSubId);
      this.btcWidgetSubId = null;
    }
    if (this.walletSubId) {
      TypedEventBus.getInstance().off(this.walletSubId);
      this.walletSubId = null;
    }
    if (this.hiddenSubId) {
      TypedEventBus.getInstance().off(this.hiddenSubId);
      this.hiddenSubId = null;
    }
    window.removeEventListener(
      'router:history-changed',
      this.onRouterHistoryChanged
    );
    this.onSettingsClosed();
    this.drawer?.setOnClosed(null);
    this.drawer = null;
    this.closeDetachedDetail();
    for (const surface of this.surfaces.values()) {
      surface.view?.destroy?.();
    }
    this.surfaces.clear();
    this.objects.clear();
    this.scrollTopState.clear();
    for (const mgr of this.badgeManagers) mgr.destroy();
    this.badgeManagers = [];
    for (const dispose of this.tooltipDisposers) dispose();
    this.tooltipDisposers = [];
    this.grid?.remove();
  }

  /**
   * History sync: re-derive the shell state from a URL — the Global Back
   * button, browser back/forward and hardware back all move the Router's
   * custom stack; this turns the resulting path back into shell state
   * (which object is focused, which state its surface shows). Boot
   * deep-links (reload on /note/:nevent) come through here too.
   * Returns false when the URL is not shell-owned (classic routes) —
   * the caller leaves those alone.
   */
  async syncFromUrl(path: string): Promise<boolean> {
    if (this.morphing) return true; // a morph is running — do not fight it
    if (path === HOME_ROUTE) {
      if (this.activeId) this.close();
      return true;
    }
    const state = parseFocusUrl(path, this.activeId);
    if (!state) return false;
    const def = FOCUS_DOMAINS.find(d => d.id === state.defId);
    if (!def?.createSurface) return false;
    if (this.hiddenIds.includes(def.id)) {
      // A URL state of a hidden owner. With a detached detail open this
      // is the RESTORE path (the global back button unwinding the
      // Phase 5 seam fallback — the stash returns to the column). A
      // deep link with nothing detached is a graph bug / dead entry:
      // tripwire, no hidden code is ensure-loaded.
      if (this.detached) {
        this.closeDetachedDetail();
        return true;
      }
      reportDependencyError(
        'focus-stage:syncFromUrl',
        def.id,
        `route "${path}"`
      );
      return false;
    }
    if (this.detached) this.closeDetachedDetail();
    if (this.activeId === def.id) {
      await this.surfaces.get(def.id)?.view?.restoreState?.(state);
      return true;
    }
    await this.switchTo(def, undefined, state);
    return true;
  }

  /**
   * Wire the ED-b bottom drawer (the shell owns it; the stage mounts the
   * per-object settings panel into its panel on the gear action).
   */
  bindSettingsDrawer(drawer: FocusSettingsDrawer): void {
    this.drawer = drawer;
    // Any close path (tab click, drag snap, programmatic close) tears the
    // mounted panel down and clears the gear's active state.
    drawer.setOnClosed(() => this.onSettingsClosed());
    // Tab-open (no gear): the drawer opens onto the Hidden Features
    // panel (SV) or an empty panel (FV — future home of the system
    // logs with their diag-log export buttons).
    drawer.setOnOpened(() => this.onDrawerOpened());
  }

  /**
   * The ED-b opened via its tab (not the gear): on the start view mount
   * the Hidden Features panel; in a focused view (FV) mount the
   * flattened system-log stream + Export DiagLogs. A per-object
   * settings panel (gear) always wins.
   */
  private onDrawerOpened(): void {
    if (this.settingsView || !this.drawer) return;
    this.unmountTabPanels();
    const host = document.createElement('div');
    if (this.activeId) {
      // FV: one continuous log stream (classic global/page split gone;
      // page entries keep the v1 semantics — view-filtered, cleared on
      // navigation) + the diag-log export button.
      host.className = 'focus-settings focus-settings--focus-log';
      this.logPanelHost = host;
      this.logPanelView = new FocusLogPanel();
      this.logPanelView.mount(host);
    } else {
      host.className = 'focus-settings focus-settings--hidden-features';
      this.hiddenPanelHost = host;
      this.hiddenPanelView = new HiddenFeaturesPanel();
      this.hiddenPanelView.mount(host);
    }
    this.drawer.panel.appendChild(host);
  }

  /** Tear the tab-open panels down (close or gear takeover). */
  private unmountTabPanels(): void {
    if (this.hiddenPanelView) {
      this.hiddenPanelView.destroy();
      this.hiddenPanelView = null;
      this.hiddenPanelHost?.remove();
      this.hiddenPanelHost = null;
    }
    if (this.logPanelView) {
      this.logPanelView.destroy();
      this.logPanelView = null;
      this.logPanelHost?.remove();
      this.logPanelHost = null;
    }
  }

  /**
   * The gear action: open the ED-b bottom drawer with this object's
   * settings panel. Toggle — clicking again closes via the drawer.
   * While the active surface shows its secondary detail (e.g. the
   * composer), the surface can swap in its own panel
   * (getSettingsForCurrentState) — Timeline settings only in /timeline.
   */
  private async toggleSettings(
    def: FocusDomainDef,
    btn: HTMLElement
  ): Promise<void> {
    if (!this.drawer) return;
    if (this.settingsView) {
      this.drawer.close();
      return;
    }
    // Gear takeover: a mounted tab-open panel (Hidden Features / log
    // stream) yields to the object's own settings panel.
    this.unmountTabPanels();
    const surface = this.surfaces.get(def.id);
    let settings: FocusSettingsView | null = null;
    if (surface?.view?.getSettingsForCurrentState) {
      settings = await surface.view.getSettingsForCurrentState();
    }
    if (!settings && !def.createSettings) return;
    const host = document.createElement('div');
    host.className = 'focus-settings';
    this.settingsHost = host;
    this.settingsDef = def;
    this.settingsView = settings ?? def.createSettings!();
    this.settingsFromSecondary = !!settings;
    this.drawer.panel.appendChild(host);
    this.settingsView.mount(host);
    this.drawer.open();
    btn.classList.add('is-active');
  }

  /** Drawer closed (any way): tear the settings panel down. */
  private onSettingsClosed(): void {
    this.unmountTabPanels();
    if (this.settingsDef) {
      this.objects
        .get(this.settingsDef.id)
        ?.querySelector("[data-focus-action='settings']")
        ?.classList.remove('is-active');
    }
    this.settingsView?.destroy();
    this.settingsView = null;
    this.settingsHost?.remove();
    this.settingsHost = null;
    this.settingsFromSecondary = false;
    this.settingsDef = null;
  }

  /**
   * Focus navigation seam: hand a view type to the ACTIVE surface's
   * column (e.g. a note click in the timeline). When the active surface
   * declines (or nothing is focused), the domain that OWNS the view type
   * takes over: the focus switches to it (one morph) and the detail
   * opens there — e.g. a quoted-article click inside the timeline morphs
   * to the Articles object with the article already in the column.
   * Returns false only when no domain owns the type — the caller
   * (ViewNavigationController) then navigates the classic way.
   */
  handleFocusNav(viewType: string, param?: string): boolean {
    if (this.activeId) {
      const surface = this.surfaces.get(this.activeId);
      if (surface?.view?.handleFocusNav?.(viewType, param)) return true;
    }
    if (this.morphing) return false;
    const def = FOCUS_DOMAINS.find(
      d => !this.hiddenIds.includes(d.id) && d.viewTypes?.includes(viewType)
    );
    if (!def) {
      // No visible owner: a hidden owner's detail renders DETACHED in the
      // active column (Phase 5 feature — not a dependency error); only a
      // miss with NO active host falls through to the tripwire (the
      // classic layer below the shell would render it invisibly).
      const owner = FOCUS_DOMAINS.find(d => d.viewTypes?.includes(viewType));
      if (owner && this.hiddenIds.includes(owner.id)) {
        if (this.activeId && DETACHED_DETAILS[viewType]) {
          // Fire-and-forget: the seam contract is sync; the component
          // factory imports lazily and swaps into the column when ready.
          void this.openDetachedDetail(viewType, param);
          return true;
        }
        reportDependencyError(
          'focus-stage:handleFocusNav',
          owner.id,
          `view type "${viewType}" (no active host for detached render)`
        );
      }
      return false;
    }
    if (!def.createSurface) return false;
    void this.switchTo(def, param ? { viewType, param } : { viewType });
    return true;
  }

  private createObject(def: FocusDomainDef): HTMLElement {
    const el = document.createElement('div');
    el.className = 'focus-object';
    el.dataset.domainId = def.id;
    el.innerHTML = `
      <button type="button" class="focus-object__hit">
        ${def.icon ? `<svg class="focus-object__icon"><use href="#${def.icon}"/></svg>` : ''}
        <span class="focus-object__label">${def.label}</span>
      </button>
      <button type="button" class="focus-object__move" data-focus-action="move" aria-label="${_('Reorder')}">
        <svg width="15" height="15" aria-hidden="true"><use href="#icon-move"/></svg>
      </button>
      <button type="button" class="focus-object__hide" data-focus-action="hide" aria-label="${_('Hide')}"${
        canHideObject(
          def.id,
          FOCUS_DOMAINS.map(d => d.id),
          this.hiddenIds
        )
          ? ''
          : ' hidden'
      }>
        <svg width="15" height="15" aria-hidden="true"><use href="#icon-eye-closed"/></svg>
      </button>
      <div class="focus-object__actions">
        <button type="button" class="focus-object__control" data-focus-action="close"
          aria-label="${_('Close')}">
          <svg width="15" height="15" aria-hidden="true"><use href="#icon-close"/></svg>
        </button>
        <button type="button" class="focus-object__back" data-focus-action="back"
          hidden
          aria-label="${_('Back')}">
          <svg width="15" height="15" aria-hidden="true"><use href="#icon-back"/></svg>
        </button>
        <button type="button" class="focus-object__scroll-top" data-focus-action="scroll-top"
          hidden
          aria-label="${_('Scroll to top')}">
          <svg width="15" height="15" aria-hidden="true" class="focus-object__scroll-top-icon"><use href="#icon-back"/></svg>
        </button>
        ${
          def.createSettings
            ? `
        <button type="button" class="focus-object__settings" data-focus-action="settings"
          aria-label="${_('Settings')}">
          <svg width="15" height="15" aria-hidden="true"><use href="#icon-settings"/></svg>
        </button>`
            : ''
        }
      </div>
      ${DIODES[def.id] ?? ''}
      <div class="focus-object__content focus-object__content--${def.id}" data-focus-slot></div>
    `;
    el.addEventListener('click', () => void this.onObjectClick(def));
    // Move handle: pointer drag reorders the circles (drop on another
    // circle swaps the two positions, persisted per account). The handle
    // click itself must never open the object.
    const moveBtn = el.querySelector(
      "[data-focus-action='move']"
    ) as HTMLElement;
    moveBtn.addEventListener('click', e => e.stopPropagation());
    moveBtn.addEventListener('pointerdown', e => {
      if (this.morphing) return;
      if (this.activeId) {
        // Focused (FV): only side-stack circles drag — the active one keeps
        // its slot in the center column.
        if (def.id !== this.activeId) this.startColumnDrag(e, def.id, el);
        return;
      }
      this.startOrderDrag(e, def.id, el);
    });
    // Hide affordance (docs/todos/hidden-objects.md): removes the circle
    // from the grid AND unloads the object's code (RAM principle). The
    // event listener applies the change to the live grid — the click
    // itself stays optimistic (no await, no dialog).
    const hideBtn = el.querySelector(
      "[data-focus-action='hide']"
    ) as HTMLElement | null;
    hideBtn?.addEventListener('click', e => {
      e.stopPropagation();
      if (this.morphing || def.id === this.activeId) return;
      hideObject(def.id);
    });
    const control = el.querySelector(
      "[data-focus-action='close']"
    ) as HTMLElement;
    control.addEventListener('click', e => {
      // The control only exists on the active object (hidden in grid state
      // via CSS) and always means "close"; never re-trigger "open".
      e.stopPropagation();
      if (this.activeId === def.id && !this.morphing) {
        e.stopPropagation();
        this.close();
      }
    });
    // Action-button stack: the surface reports detail state via the frame
    // (focusSurfaceFrame.setBackVisible bubbles 'focus:surface-back') —
    // the back action shows only while a detail replaces the list.
    const backBtn = el.querySelector(
      "[data-focus-action='back']"
    ) as HTMLElement;
    el.addEventListener('focus:surface-back', e => {
      const detail = (e as CustomEvent<{ visible?: boolean }>).detail;
      backBtn.hidden = !detail?.visible;
      if (
        !detail?.visible &&
        this.settingsDef?.id === def.id &&
        this.settingsFromSecondary
      ) {
        // The secondary detail closed (e.g. composer posted/cancelled):
        // its settings panel is state-specific — close the drawer with it.
        this.drawer?.close();
      }
      // Sync the scroll-to-top action with the swap (no scroll event
      // fires when a view replaces another): a fresh detail starts at
      // the top — hide; back on the list means its preserved scroll
      // position — resync (button reappears if the list stayed scrolled).
      const st = this.scrollTopState.get(def.id);
      if (st) {
        if (detail?.visible) {
          st.btn.hidden = true;
        } else {
          const slot = el.querySelector('[data-focus-slot]') as HTMLElement;
          st.source = this.findMainScroller(slot);
          st.btn.hidden = !(
            st.source && st.source.scrollTop > SCROLL_TOP_THRESHOLD
          );
        }
      }
    });
    backBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (this.activeId !== def.id || this.morphing) return;
      // History back, v1-parity: the Global Back Button mechanism. The
      // current detail can veto first (e.g. the composer's unsaved-
      // content guard) — the history must not move past a deferred back.
      if (this.surfaces.get(def.id)?.view?.confirmBack?.() === false) return;
      NavigationDispatcher.goBack();
    });

    // Scroll-to-top action: visible once the column's main scroller is
    // scrolled past the threshold, scrolls it back smooth on click. The
    // captured scroll listener reaches BOTH scroll models — the slot
    // itself (articles: the column scrolls) and internal scrollers
    // (social: the timeline scrolls inside the view) — scroll doesn't
    // bubble, but capture on the slot receives every descendant's event.
    const slot = el.querySelector('[data-focus-slot]') as HTMLElement;
    const scrollTopBtn = el.querySelector(
      "[data-focus-action='scroll-top']"
    ) as HTMLElement;
    const scrollTop = { btn: scrollTopBtn, source: null as HTMLElement | null };
    this.scrollTopState.set(def.id, scrollTop);
    slot.addEventListener(
      'scroll',
      e => {
        const t = e.target;
        if (!(t instanceof HTMLElement)) return;
        // Ignore stale events from views swapped out of the column (a
        // detached timeline keeps polling and scrolling) — only elements
        // currently IN the column drive the action.
        if (!slot.contains(t)) return;
        // Only the column's main scroller drives the action — the slot
        // itself, or a descendant scroller occupying most of the column
        // (social timeline). Small nested scrollers (dropdowns) don't.
        if (t !== slot && t.clientHeight < slot.clientHeight * 0.6) return;
        scrollTop.source = t;
        scrollTop.btn.hidden = t.scrollTop <= SCROLL_TOP_THRESHOLD;
      },
      true
    );
    scrollTopBtn.addEventListener('click', e => {
      e.stopPropagation();
      const t = scrollTop.source ?? this.findMainScroller(slot);
      t?.scrollTo({ top: 0, behavior: 'smooth' });
    });

    // Settings action (gear): opens the ED-b bottom drawer with THIS
    // object's settings panel (def.createSettings decides visibility).
    if (def.createSettings) {
      const settingsBtn = el.querySelector(
        "[data-focus-action='settings']"
      ) as HTMLElement;
      settingsBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (this.activeId !== def.id || this.morphing) return;
        void this.toggleSettings(def, settingsBtn);
      });
    }
    // Tooltips on every 30px control (nn-tooltip, shared popup portalled
    // to <body>). The aria-label texts already describe the actions —
    // reuse them. Disposers tracked for the destroy contract.
    const tips: Array<[string, HTMLElement | null]> = [
      [_('Reorder'), moveBtn],
      [
        _(
          'Hide feature, it will be hidden and unloaded from the app memory. All background requests are stopped. You can unhide it in the Edge Drawer at the bottom.'
        ),
        hideBtn,
      ],
      [_('Close'), control],
      [_('Back'), backBtn],
      [_('Scroll to top'), scrollTopBtn],
      [
        _('Settings'),
        el.querySelector(
          "[data-focus-action='settings']"
        ) as HTMLElement | null,
      ],
    ];
    for (const [text, btn] of tips) {
      if (btn) this.tooltipDisposers.push(Tooltip.attach(btn, text));
    }
    this.objects.set(def.id, el);
    return el;
  }

  /**
   * The column's main scroll container: the slot itself when it overflows
   * (articles), otherwise the first descendant that actually scrolls and
   * occupies most of the column (the social timeline's inner scroller).
   * Only called on open and click — never per scroll event.
   */
  private findMainScroller(slot: HTMLElement): HTMLElement | null {
    const scrollable = (n: Element): boolean => {
      const s = window.getComputedStyle(n);
      return (
        (s.overflowY === 'auto' || s.overflowY === 'scroll') &&
        (n as HTMLElement).scrollHeight > (n as HTMLElement).clientHeight
      );
    };
    if (scrollable(slot)) return slot;
    for (const d of slot.querySelectorAll('*')) {
      if (d instanceof HTMLElement && scrollable(d)) return d;
    }
    return null;
  }

  private async onObjectClick(def: FocusDomainDef): Promise<void> {
    if (this.morphing) return; // a morph is running — ignore stray clicks
    if (!def.createSurface) return; // placeholder domain, no surface yet
    if (this.activeId === def.id) return; // active body — close lives on the control
    await this.switchTo(def);
  }

  /**
   * Object-to-object switch (also the cross-object seam entry): swap
   * the focus to another domain in ONE morph — the old object shrinks
   * back to its circle while the new one grows into the column. The
   * optional handoff opens a detail on the new surface before the
   * morph, so the column lands on its final content (e.g. the quoted
   * article clicked inside the timeline). A `restore` state (history
   * sync) replaces the handoff: the surface re-derives its state from
   * the parsed URL instead of opening a fresh seam detail.
   */
  private async switchTo(
    def: FocusDomainDef,
    nav?: FocusHandoff,
    restore?: FocusUrlState
  ): Promise<void> {
    const el = this.objects.get(def.id);
    if (!el || !def.createSurface) return;
    if (this.activeId === def.id) {
      // Already focused: only the handoff matters (e.g. an article link
      // clicked while the Articles object is open).
      if (nav) {
        this.surfaces
          .get(def.id)
          ?.view?.handleFocusNav?.(nav.viewType, nav.param);
      }
      return;
    }
    await this.open(def, el, nav, restore);
  }

  private async open(
    def: FocusDomainDef,
    el: HTMLElement,
    nav?: FocusHandoff,
    restore?: FocusUrlState
  ): Promise<void> {
    // Column content switches — object settings (ED-b) belong to the old
    // object and follow it out; the tab-open panels (Hidden Features,
    // log stream) too — they must not ride along into a focused view.
    if (this.settingsView || this.hiddenPanelView || this.logPanelView)
      this.drawer?.close();
    // Object-to-object switch: capture the old object up front — it is
    // torn down inside the mutation phase below, so one FLIP pass
    // animates the old object back to its circle while the new one
    // grows into the column (no route detour through the home grid).
    const oldId = this.activeId !== def.id ? this.activeId : null;
    const oldEl = oldId ? this.objects.get(oldId) : undefined;
    const oldSurface = oldId ? this.surfaces.get(oldId) : undefined;
    // A detached detail (Phase 5) belongs to the old host column — its
    // component dies before the teardown animates.
    if (oldId) this.closeDetachedDetail();

    this.morphing = true;
    this.activeId = def.id;
    const takeOver = window.matchMedia(MORPH_MIN_QUERY).matches;

    // Surface mounts BEFORE the morph: in document flow the column height
    // is its content height — the FLIP needs the laid-out final geometry.
    // A handoff detail is created first too (into the still-detached
    // frame), so the column grows with the final content instead of a
    // list that swaps away a moment later.
    const surface = await this.ensureSurface(def);
    if (this.activeId !== def.id) {
      this.morphing = false; // closed again while loading
      return;
    }
    if (restore) {
      // History sync (back/forward/deep-link): re-derive the surface's
      // state from the parsed URL. Same detached-frame caveat as the
      // handoff above — set the back action manually for detail states.
      try {
        await surface.view?.restoreState?.(restore);
        const backBtn = el.querySelector(
          "[data-focus-action='back']"
        ) as HTMLElement;
        if (backBtn) backBtn.hidden = restore.kind === 'list';
      } catch {
        surface.view?.syncUrl?.();
      }
    } else if (nav) {
      if (surface.view?.openDetail) {
        try {
          await surface.view.openDetail(nav.param);
          // The frame's setBackVisible event was dispatched while the
          // frame was still detached (handoff runs before appendChild) —
          // the object's back action is wired via that event, so set it
          // here.
          const backBtn = el.querySelector(
            "[data-focus-action='back']"
          ) as HTMLElement;
          if (backBtn) backBtn.hidden = false;
        } catch {
          // Handoff failed (e.g. detail import) — fall back to the list
          // and its URL instead of bricking the morph.
          surface.view?.syncUrl?.();
        }
      } else {
        // Object-root seam nav (no detail — e.g. 'tribes' from the TV
        // tab row): a deliberate object switch — the URL follows the
        // domain route like a circle click would (push: real step).
        if (surface.view?.syncUrl) surface.view.syncUrl();
        else if (def.route) pushFocusUrl(def.route);
      }
    }

    // Measure the TRUE before-geometry: the old object is still the
    // column, the new one still a circle.
    const first = takeOver ? null : this.measureAll();

    // Mutation phase (one task — no paint in between): swap the focus.
    if (oldId) {
      if (oldSurface) {
        // Ephemeral surfaces (on-demand addon objects) die on switch —
        // leaving the object unloads the addon runtime.
        if (oldSurface.ephemeral) {
          oldSurface.view?.destroy?.();
          this.surfaces.delete(oldId);
        } else {
          oldSurface.view?.pause?.();
          // Handoff switch: the old object keeps its full state (list OR
          // detail) — back returns to exactly what the user came from.
          // Deliberate switches (circle click) reset it to the list.
          if (!nav) {
            oldSurface.view?.reset?.();
          }
        }
        oldSurface.detach();
      }
      // The old column is gone — reset its scroll-to-top action for a
      // clean reopen (same contract as close()).
      const oldSt = this.scrollTopState.get(oldId);
      if (oldSt) {
        oldSt.source = null;
        oldSt.btn.hidden = true;
      }
      if (oldEl) {
        oldEl.classList.remove('focus-object--active');
        oldEl.style.gridColumn = '';
      }
      this.restoreSideCircles();
    }

    const slot = el.querySelector('[data-focus-slot]') as HTMLElement;
    surface.attach(slot);
    surface.view?.resume?.();
    el.classList.add('focus-object--active');
    this.grid.classList.add('is-focused');
    if (!takeOver) {
      // The side circles re-parent into per-side stacks so their rows
      // stay compact while the active column's content height stretches
      // the middle row (in flow → the page scrolls the column).
      el.style.gridColumn = '2';
      this.reparentSideStacks(def.id);
    }
    // A reopened (cached) surface may already be scrolled — sync the
    // scroll-to-top action to the restored state.
    const st = this.scrollTopState.get(def.id);
    if (st) {
      st.source = this.findMainScroller(slot);
      st.btn.hidden = !(
        st.source && st.source.scrollTop > SCROLL_TOP_THRESHOLD
      );
    }

    // URL follows the restored state (in place, no history entry): a
    // handoff's detail set its own URL already; otherwise the surface
    // syncs — a preserved detail keeps its route — falling back to the
    // domain route. Circle clicks PUSH (a real history step); restores
    // no-op (pushUrl's same-path guard — the URL is already correct).
    if (!nav && !restore) {
      if (surface.view?.syncUrl) surface.view.syncUrl();
      else if (def.route) pushFocusUrl(def.route);
    }

    let morphDone: Promise<unknown> = Promise.resolve();
    if (first) morphDone = this.flipAll(first); // null = takeover, no FLIP

    await morphDone;
    if (this.activeId !== def.id) {
      this.morphing = false; // closed (e.g. resize) during the morph
      return;
    }
    this.morphing = false;
  }

  private close({ animate = true }: { animate?: boolean } = {}): void {
    if (!this.activeId) return;
    if (this.morphing && animate) return; // a morph is already running
    const def = FOCUS_DOMAINS.find(d => d.id === this.activeId);
    const el = def ? this.objects.get(def.id) : undefined;
    if (!def || !el) return;
    // A detached detail (Phase 5) dies with its host column.
    this.closeDetachedDetail();
    const takeOver = window.matchMedia(MORPH_MIN_QUERY).matches;
    // Object settings (ED-b) die with their object.
    if (this.settingsView) this.drawer?.close();

    // Capture the focused geometry FIRST (content still mounted): in
    // document flow the column height is its content — after the surface
    // detaches, the box collapses and the morph-back would start from a
    // sliver.
    const first = animate && !takeOver ? this.measureAll() : null;

    // Detach the surface first: the view pauses, its element is kept
    // cached so reopening does not refetch everything. The surface
    // returns to its list state — reopening never shows a stale detail.
    // Ephemeral surfaces (on-demand addon objects) are destroyed and
    // evicted instead — leaving the object unloads the addon runtime.
    const surface = this.surfaces.get(def.id);
    if (surface) {
      if (surface.ephemeral) {
        surface.view?.destroy?.();
        this.surfaces.delete(def.id);
      } else {
        surface.view?.pause?.();
        surface.view?.reset?.();
      }
      surface.detach();
    }
    // The column is gone — reset the scroll-to-top action for a clean
    // reopen (hidden until the user scrolls again).
    const st = this.scrollTopState.get(def.id);
    if (st) {
      st.source = null;
      st.btn.hidden = true;
    }

    el.classList.remove('focus-object--active');
    this.grid.classList.remove('is-focused');
    el.style.gridColumn = '';
    this.activeId = null;
    // Back to the home grid URL (no-op when already there). PUSH: the
    // grid is a state of its own — back from it returns to the object.
    pushFocusUrl(HOME_ROUTE);
    this.restoreSideCircles();
    if (!first) return; // takeover / no-animate: plain class flip

    // FLIP back: focused geometry → circle geometry.
    this.morphing = true;
    void this.flipAll(first).then(() => {
      this.morphing = false;
    });
  }

  /**
   * Pointer drag on a circle's move handle (grid state only — never while
   * a domain is focused or a morph runs). The circle follows the cursor
   * visually; the circle under the pointer is highlighted as the drop
   * target. Dropping on another circle swaps the two ids in the stored
   * order and persists it. A few pixels of dead zone keep a shaky click
   * from becoming a drag.
   */
  /**
   * Shared translate-drag mechanics (SV order drag ↔ whole-stack drag):
   * pointerdown → 6px dead zone → the element rides the cursor via
   * transform (its grid slot stays occupied — no mid-drag reflow); the
   * hit test drives the drop highlight; pointerup commits via `onDrop`.
   * Listeners live on window (move/up/cancel) and are removed in cleanup.
   */
  private startTranslateDrag(opts: {
    e: PointerEvent;
    /** The translated element. */
    el: HTMLElement;
    /** Once when the dead zone is crossed (drag classes on). */
    onDragStart: () => void;
    /** Cleanup side of `onDragStart` (classes off). */
    onDragEnd: () => void;
    /** Drop target under the pointer, or null. */
    hitTest: (x: number, y: number) => HTMLElement | null;
    /** Highlight handoff: next replaces prev (also null/null at cleanup). */
    onTargetChange?: (
      next: HTMLElement | null,
      prev: HTMLElement | null
    ) => void;
    /** Drop commit — called after cleanup with the last target. */
    onDrop: (target: HTMLElement | null) => void;
  }): void {
    const el = opts.el;
    opts.e.stopPropagation();
    opts.e.preventDefault(); // no text selection / native drag while moving
    const startX = opts.e.clientX;
    const startY = opts.e.clientY;
    let dragging = false;
    let target: HTMLElement | null = null;

    const onMove = (ev: PointerEvent): void => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
        dragging = true;
        // pointer-events off: the translated element must not shadow the
        // drop target in elementFromPoint.
        opts.onDragStart();
      }
      el.style.transform = `translate(${ev.clientX - startX}px, ${ev.clientY - startY}px)`;
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      const next = hit ? opts.hitTest(ev.clientX, ev.clientY) : null;
      if (next !== target) {
        opts.onTargetChange?.(next, target);
        target = next;
      }
    };
    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', cleanup);
      el.style.transform = '';
      opts.onDragEnd();
      // Clear the last target's highlight (same job the per-drag cleanup
      // did before the helper existed).
      opts.onTargetChange?.(null, target);
    };
    const onUp = (): void => {
      const t = target;
      cleanup();
      opts.onDrop(t);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', cleanup);
  }

  private startOrderDrag(
    e: PointerEvent,
    dragId: string,
    el: HTMLElement
  ): void {
    if (this.activeId || this.morphing) return;
    this.startTranslateDrag({
      e,
      el,
      onDragStart: () => el.classList.add('is-drag-source'),
      onDragEnd: () => el.classList.remove('is-drag-source'),
      hitTest: (x, y) => {
        const hit = document.elementFromPoint(x, y);
        const obj = hit?.closest('[data-domain-id]') as HTMLElement | null;
        return obj && obj !== el && obj.dataset.domainId ? obj : null;
      },
      onTargetChange: (next, prev) => {
        prev?.classList.remove('is-drop-target');
        next?.classList.add('is-drop-target');
      },
      onDrop: t => {
        const dropId = t?.dataset.domainId;
        if (dropId) this.swapOrder(dragId, dropId);
      },
    });
  }

  /**
   * Pointer drag on a side stack's move handle (focused state only).
   * The WHOLE column rides at the cursor tip (same feel as the SV order
   * drag) — transform only, so its grid slot stays occupied and the stage
   * does not reflow mid-drag. Dragging it toward the OPPOSITE stack
   * highlights that stack as the drop zone; dropping there moves ALL
   * circles into it — in the user's stored order — and persists the side
   * (the source column empties as the future secondary-widget area). Same
   * dead-zone mechanics as startOrderDrag.
   */
  private startStackDrag(e: PointerEvent, side: 'left' | 'right'): void {
    if (this.morphing || !this.sideStacks) return;
    const targetEl = side === 'left' ? this.sideStacks[1] : this.sideStacks[0];
    const sourceEl = this.sideStacks[side === 'left' ? 0 : 1];
    this.startTranslateDrag({
      e,
      el: sourceEl,
      onDragStart: () => {
        sourceEl.classList.add('is-drag-source');
        targetEl.classList.add('is-dropzone');
      },
      onDragEnd: () => {
        sourceEl.classList.remove('is-drag-source');
        targetEl.classList.remove('is-dropzone');
      },
      hitTest: (x, y) => {
        const hit = document.elementFromPoint(x, y);
        return hit && hit.closest('[data-focus-stack]') === targetEl
          ? targetEl
          : null;
      },
      onDrop: t => {
        if (t) this.moveAllCircles(side === 'left' ? 'right' : 'left');
      },
    });
  }

  /**
   * Pointer drag on a side-stack circle's move handle (focused state).
   * The circle is lifted OUT of its stack (position: fixed — the stack's
   * overflow clipping would otherwise cut the visual mid-flight) and
   * follows the cursor; its slot closes up and an insertion line marks the
   * exact drop position in BOTH columns: above all circles (column top,
   * later the widget slot) or between two circles. Dropping writes the new
   * per-column arrangement to FOCUS_UI_COLUMN_LAYOUT — the SV grid order
   * is untouched — and re-distributes. Same dead-zone mechanics as
   * startOrderDrag.
   */
  private startColumnDrag(
    e: PointerEvent,
    dragId: string,
    el: HTMLElement
  ): void {
    this.startStackItemDrag({
      e,
      el,
      dragClasses: ['is-drag-source', 'is-column-drag'],
      itemsIn: stack =>
        (
          [...stack.querySelectorAll('[data-domain-id]')] as HTMLElement[]
        ).filter(c => !c.classList.contains('is-column-drag')),
      dropTarget: (x, y) => this.columnDropTarget(x, y),
      onDrop: t => {
        if (!t || !this.sideStacks) return;
        const side = t.stack === this.sideStacks[0] ? 'left' : 'right';
        this.moveCircleTo(dragId, side, t.index);
      },
    });
  }

  /**
   * Shared drag mechanics for side-stack items (circle drag ↔ widget
   * drag): the item is lifted OUT of its stack (position: fixed — the
   * stack's overflow clipping would otherwise cut the visual mid-flight)
   * and follows the cursor; its slot closes up and an insertion line
   * marks the exact drop position in BOTH stacks. Dead-zone activation
   * (6px), pointerup/pointercancel cleanup, `onDrop` persists.
   */
  private startStackItemDrag(opts: {
    e: PointerEvent;
    el: HTMLElement;
    /** Classes toggled while dragging (e.g. is-drag-source). */
    dragClasses: string[];
    /** Droppable items of a stack (excluding the dragged element). */
    itemsIn: (stack: HTMLElement) => HTMLElement[];
    dropTarget: (
      x: number,
      y: number
    ) => { stack: HTMLElement; index: number } | null;
    onDrop: (t: { stack: HTMLElement; index: number } | null) => void;
  }): void {
    const el = opts.el;
    if (this.morphing || !this.sideStacks) return;
    const e = opts.e;
    e.stopPropagation();
    e.preventDefault(); // no text selection / native drag while moving
    const startX = e.clientX;
    const startY = e.clientY;
    const rect = el.getBoundingClientRect();
    const grabX = e.clientX - rect.left;
    const grabY = e.clientY - rect.top;
    let dragging = false;
    let line: HTMLElement | null = null;
    let target: { stack: HTMLElement; index: number } | null = null;

    // Insertion line into the target stack at the boundary of `index`
    // (0 = above the first visible item). Absolute inside the stack, so
    // no grid rows shift while it moves; coordinates are content-space
    // (scroll-aware).
    const placeLine = (t: { stack: HTMLElement; index: number }): void => {
      const stackRect = t.stack.getBoundingClientRect();
      const scrollTop = t.stack.scrollTop;
      const items = opts.itemsIn(t.stack);
      const halfGap = parseFloat(getComputedStyle(t.stack).rowGap) / 2 || 0;
      let y: number;
      if (items.length === 0) {
        const tools = t.stack.querySelector(
          '[data-focus-stack-tools]'
        ) as HTMLElement | null;
        y = tools
          ? tools.getBoundingClientRect().bottom -
            stackRect.top +
            scrollTop +
            halfGap
          : halfGap;
      } else if (t.index >= items.length) {
        const last = items[items.length - 1];
        if (!last) return;
        const r = last.getBoundingClientRect();
        y = r.bottom - stackRect.top + scrollTop + halfGap;
      } else {
        const next = items[t.index];
        if (!next) return;
        const r = next.getBoundingClientRect();
        y = r.top - stackRect.top + scrollTop - halfGap;
      }
      if (!line) {
        line = document.createElement('div');
        line.className = 'focus-side-stack__drop-line';
      }
      line.style.top = `${y - 1}px`; // -1: center the 2px line on the boundary
      if (line.parentElement !== t.stack) t.stack.appendChild(line);
    };

    const onMove = (ev: PointerEvent): void => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
        dragging = true;
        // Fixed lift: escapes the stack's overflow clipping; the hole in
        // the source column closes (the insertion line takes its place).
        el.classList.add(...opts.dragClasses);
        el.style.position = 'fixed';
        el.style.left = `${rect.left}px`;
        el.style.top = `${rect.top}px`;
        el.style.width = `${rect.width}px`;
        el.style.height = `${rect.height}px`;
      }
      el.style.left = `${ev.clientX - grabX}px`;
      el.style.top = `${ev.clientY - grabY}px`;
      const next = opts.dropTarget(ev.clientX, ev.clientY);
      if (
        !!next !== !!target ||
        (next &&
          target &&
          (next.stack !== target.stack || next.index !== target.index))
      ) {
        line?.remove();
        line = null;
        if (next) placeLine(next);
        target = next;
      }
    };
    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', cleanup);
      el.classList.remove(...opts.dragClasses);
      el.style.position = '';
      el.style.left = '';
      el.style.top = '';
      el.style.width = '';
      el.style.height = '';
      line?.remove();
      line = null;
    };
    const onUp = (): void => {
      const t = target;
      cleanup();
      opts.onDrop(t);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', cleanup);
  }

  /** Move ALL circles into the given stack (SV order), persist. */
  private moveAllCircles(side: 'left' | 'right'): void {
    if (!this.sideStacks || !this.activeId) return;
    const svOrder = this.orderedDefs().map(d => d.id);
    this.columnLayout = {
      left: side === 'left' ? svOrder : [],
      right: side === 'right' ? svOrder : [],
    };
    PerAccountLocalStorage.getInstance().set(
      StorageKeys.FOCUS_UI_COLUMN_LAYOUT,
      this.columnLayout
    );
    this.distributeSideCircles(
      this.sideStacks[0],
      this.sideStacks[1],
      this.activeId
    );
    this.reapplyWidgets();
  }

  /**
   * Which side stack the pointer is over and at which VISIBLE position the
   * drop would insert (0 = above all circles of that column, circles.length
   * = below the last). Null when the pointer is outside both stacks. The
   * active circle never counts — it is not rendered in the stacks.
   */
  private columnDropTarget(
    x: number,
    y: number
  ): { stack: HTMLElement; index: number } | null {
    if (!this.sideStacks) return null;
    const hit = document.elementFromPoint(x, y);
    const stack = hit?.closest('[data-focus-stack]') as HTMLElement | null;
    if (
      !stack ||
      (stack !== this.sideStacks[0] && stack !== this.sideStacks[1])
    )
      return null;
    // The lifted circle is still a DOM child of its source stack (fixed
    // positioning) — exclude it, it holds no drop position.
    const circles = (
      [...stack.querySelectorAll('[data-domain-id]')] as HTMLElement[]
    ).filter(c => !c.classList.contains('is-column-drag'));
    for (let i = 0; i < circles.length; i++) {
      const circle = circles[i];
      if (!circle) continue;
      const r = circle.getBoundingClientRect();
      if (y < r.top + r.height / 2) return { stack, index: i };
    }
    return { stack, index: circles.length };
  }

  /**
   * Move ONE circle to an exact position in a column (visible index,
   * 0 = above all circles of the target column) and persist. The index
   * counts the circles VISIBLE in the column — the active circle is skipped
   * when mapping it onto the underlying id lists (it holds its own slot).
   */
  private moveCircleTo(
    dragId: string,
    side: 'left' | 'right',
    index: number
  ): void {
    if (!this.sideStacks || !this.activeId) return;
    const activeId = this.activeId;
    const layout = this.effectiveLayout();
    const source = layout.left.includes(dragId) ? 'left' : 'right';
    const target = layout[side].filter(id => id !== dragId);
    // Map the visible insertion index onto the full id list (active slot
    // skipped): first position whose visible rank equals `index`.
    let insertAt = target.length;
    let seen = 0;
    for (let i = 0; i < target.length; i++) {
      if (target[i] === activeId) continue;
      if (seen === index) {
        insertAt = i;
        break;
      }
      seen++;
    }
    target.splice(insertAt, 0, dragId);
    if (source === side) {
      layout[side] = target;
    } else {
      layout[source] = layout[source].filter(id => id !== dragId);
      layout[side] = target;
    }
    this.columnLayout = { left: layout.left, right: layout.right };
    PerAccountLocalStorage.getInstance().set(
      StorageKeys.FOCUS_UI_COLUMN_LAYOUT,
      this.columnLayout
    );
    this.distributeSideCircles(
      this.sideStacks[0],
      this.sideStacks[1],
      activeId
    );
    this.reapplyWidgets();
  }

  /**
   * Reset the column layout to the default alternating 50/50 (derived
   * from the SV order, starting LEFT) and clear the persisted layout.
   * Wired to the reset button next to each stack's move handle.
   */
  private resetStackSide(): void {
    if (!this.sideStacks || !this.activeId) return;
    this.columnLayout = null;
    PerAccountLocalStorage.getInstance().set(
      StorageKeys.FOCUS_UI_COLUMN_LAYOUT,
      null
    );
    this.distributeSideCircles(
      this.sideStacks[0],
      this.sideStacks[1],
      this.activeId
    );
    this.reapplyWidgets();
  }

  // ========== FV side-stack widgets (v2) ==========

  /**
   * The widget switch in the Live Streams object flipped: place the
   * widget immediately (default spot) or remove its host — while stacks
   * exist. Without stacks the next focus picks the setting up anyway.
   */
  private onWidgetToggle(enabled: boolean): void {
    this.setWidgetAvailable('live-streams', enabled);
    if (!enabled) {
      // Widget gone: release the runtime unless another always-on reason
      // remains (background pin — the guard lives in
      // live-streams/index.ts isLiveStreamsAutoLoaded).
      void AddonLoader.getInstance().deactivateOnDemand('live-streams');
    }
  }

  /**
   * A widget's availability flipped (setting toggle, background pin):
   * place it immediately (default spot) or remove its host — while
   * stacks exist. Without stacks the next focus picks the state up.
   */
  private setWidgetAvailable(id: string, available: boolean): void {
    if (!this.sideStacks) return;
    if (available) {
      this.placeWidgets(this.sideStacks[0], this.sideStacks[1]);
      return;
    }
    const entry = this.widgetHosts.get(id);
    if (!entry) return;
    entry.widget.setFocusHost(null);
    entry.host.remove();
    this.widgetHosts.delete(id);
  }

  /**
   * The widget instance for a registered widget id — or null when its
   * runtime is not loaded yet (login race). The widget's enabled flag is
   * an always-on reason, so on first miss the runtime is loaded on
   * demand and the stacks re-applied as soon as it is up.
   */
  private widgetFor(id: string): FocusWidgetLike | null {
    // Hidden domains contribute no widgets (RAM principle) — and their
    // runtimes must not be ensure-loaded by a widget miss either.
    const domainId = Object.entries(FocusStage.WIDGETS_BY_DOMAIN).find(
      ([, widgetIds]) => widgetIds.includes(id)
    )?.[0];
    if (domainId && this.hiddenIds.includes(domainId)) return null;
    let addonId = 'live-streams';
    if (id === 'live-streams') {
      // Same contract as classic: the widget exists only while the addon
      // is enabled AND its "Show Live Streams Widget" switch is on —
      // without the enabled gate a Master-OFF/Widget-ON combination
      // would ensure-load a runtime whose widget never renders (zombie).
      if (!isLiveStreamsEnabled() || !isLiveStreamsSidebarWidget()) {
        return null;
      }
    } else if (id === 'live-streams-mini-player') {
      // Shows only while a background stream is pinned — independent of
      // the sidebar-widget setting.
      if (!hasLiveStreamsBackgroundPin()) return null;
    } else if (id === 'nostr-majlis') {
      addonId = 'nostr-majlis';
      if (!getNostrMajlisSettings().sidebarWidget) return null;
    } else if (id === 'nostr-majlis-quran') {
      addonId = 'nostr-majlis';
      if (!getNostrMajlisSettings().quranDaily) return null;
    } else if (id === 'btc-price') {
      addonId = 'btc-price';
      // Same contract as classic: the widget exists only while the addon
      // is enabled AND its "Show BTC Sidebar Widget" switch is on.
      if (!isBtcPriceEnabled() || !isBtcPriceSidebarWidget()) return null;
    } else if (id === 'wallet-balance') {
      addonId = 'wallet-balance';
      // Same as classic: the display shows whenever the addon is enabled
      // (no separate widget switch).
      if (!isWalletBalanceEnabled()) return null;
    } else {
      return null;
    }
    const loader = AddonLoader.getInstance();
    const runtime = loader.getRuntime<
      AddonRuntime & {
        widget: FocusWidgetLike | null;
        miniPlayer?: FocusWidgetLike | null;
        quranWidget?: FocusWidgetLike | null;
      }
    >(addonId);
    if (runtime) {
      if (addonId === 'nostr-majlis') {
        return id === 'nostr-majlis-quran'
          ? (runtime.quranWidget ?? null)
          : (runtime.widget ?? null);
      }
      return id === 'live-streams-mini-player'
        ? (runtime.miniPlayer ?? null)
        : (runtime.widget ?? null);
    }
    void loader.ensureLoaded(addonId).then(() => {
      if (this.sideStacks) this.reapplyWidgets();
    });
    return null;
  }

  /**
   * Mount the activated widgets into the freshly built side stacks:
   * persisted FOCUS_UI_WIDGET_LAYOUT spot or the default (right stack,
   * top — above all circles). Each host wraps the widget's DOM plus its
   * move handle.
   */
  private placeWidgets(left: HTMLElement, right: HTMLElement): void {
    for (const id of WIDGET_IDS) {
      const widget = this.widgetFor(id);
      if (!widget || this.widgetHosts.has(id)) continue;
      const host = this.createWidgetHost(id);
      const spot = this.widgetLayout[id] ?? {
        side: 'right' as const,
        index: 0,
      };
      this.insertWidgetAt(
        spot.side === 'left' ? left : right,
        host,
        spot.index,
        host
      );
      this.widgetHosts.set(id, { widget, host });
      widget.setFocusHost(host);
    }
  }

  /** Re-insert the mounted hosts per their stored spot (circles moved). */
  private reapplyWidgets(): void {
    if (!this.sideStacks) return;
    const [left, right] = this.sideStacks;
    for (const [id, entry] of this.widgetHosts) {
      const spot = this.widgetLayout[id] ?? {
        side: 'right' as const,
        index: 0,
      };
      this.insertWidgetAt(
        spot.side === 'left' ? left : right,
        entry.host,
        spot.index,
        entry.host
      );
    }
    // Mount widgets that became available in the meantime (widgetFor
    // fires ensureLoaded on the first miss; its guard skips ids that
    // already have a host).
    this.placeWidgets(left, right);
  }

  /** The widget's stage slot: move handle (drag) + the widget's DOM. */
  private createWidgetHost(id: string): HTMLElement {
    const host = document.createElement('div');
    host.className = 'focus-widget-slot';
    host.dataset.focusWidget = id;
    const move = document.createElement('button');
    move.type = 'button';
    move.className = 'focus-widget-slot__move';
    move.setAttribute('data-focus-widget-move', '');
    move.setAttribute('aria-label', _('Move widget'));
    move.innerHTML =
      '<svg width="15" height="15" aria-hidden="true"><use href="#icon-move"/></svg>';
    move.addEventListener('pointerdown', ev =>
      this.startWidgetDrag(ev, id, host)
    );
    move.addEventListener('click', ev => ev.stopPropagation());
    Tooltip.attach(move, _('Move widget'));
    host.appendChild(move);
    return host;
  }

  /** The stack's item flow: circles + widget slots, in DOM order. */
  private stackItems(stack: HTMLElement, exclude?: HTMLElement): HTMLElement[] {
    return ([...stack.children] as HTMLElement[]).filter(
      el =>
        el !== exclude &&
        (el.hasAttribute('data-domain-id') ||
          el.hasAttribute('data-focus-widget'))
    );
  }

  /**
   * Insert a widget host at the given position in the stack's item flow
   * (index 0 = directly under the tools). `exclude` keeps the dragged
   * host from holding a position in its own target calculation.
   */
  private insertWidgetAt(
    stack: HTMLElement,
    host: HTMLElement,
    index: number,
    exclude?: HTMLElement
  ): void {
    const items = this.stackItems(stack, exclude);
    const ref = items[index] ?? null;
    if (ref) stack.insertBefore(host, ref);
    else stack.appendChild(host);
  }

  /**
   * Drag a widget to another position: fixed lift (escapes the stack's
   * overflow clipping), a drop-line marks the exact insertion point in
   * BOTH stacks (between any two items — circles and widget slots), the
   * drop persists FOCUS_UI_WIDGET_LAYOUT and re-inserts. Same dead-zone
   * mechanics as startColumnDrag.
   */
  private startWidgetDrag(
    e: PointerEvent,
    id: string,
    host: HTMLElement
  ): void {
    this.startStackItemDrag({
      e,
      el: host,
      dragClasses: ['is-drag-source'],
      itemsIn: stack => this.stackItems(stack, host),
      dropTarget: (x, y) => this.widgetDropTarget(x, y, host),
      onDrop: t => {
        if (!t || !this.sideStacks) return;
        const side = t.stack === this.sideStacks[0] ? 'left' : 'right';
        this.moveWidgetTo(id, side, t.index);
      },
    });
  }

  /**
   * Which side stack the pointer is over and at which position the drop
   * would insert (0 = above all items of that column). Null outside both
   * stacks. The dragged host holds no drop position.
   */
  private widgetDropTarget(
    x: number,
    y: number,
    dragHost: HTMLElement
  ): { stack: HTMLElement; index: number } | null {
    if (!this.sideStacks) return null;
    const hit = document.elementFromPoint(x, y);
    const stack = hit?.closest('[data-focus-stack]') as HTMLElement | null;
    if (
      !stack ||
      (stack !== this.sideStacks[0] && stack !== this.sideStacks[1])
    )
      return null;
    const items = this.stackItems(stack, dragHost);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;
      const r = item.getBoundingClientRect();
      if (y < r.top + r.height / 2) return { stack, index: i };
    }
    return { stack, index: items.length };
  }

  /** Move ONE widget to an exact position in a column and persist. */
  private moveWidgetTo(
    id: string,
    side: 'left' | 'right',
    index: number
  ): void {
    if (!this.sideStacks) return;
    this.widgetLayout[id] = { side, index };
    this.persistWidgetLayout();
    const entry = this.widgetHosts.get(id);
    if (!entry) return;
    this.insertWidgetAt(
      side === 'left' ? this.sideStacks[0] : this.sideStacks[1],
      entry.host,
      index,
      entry.host
    );
  }

  /** Swap two ids in the stored order, persist, re-apply the grid order. */
  private swapOrder(a: string, b: string): void {
    if (a === b) return;
    const ia = this.order.indexOf(a);
    const ib = this.order.indexOf(b);
    if (ia < 0 || ib < 0) return;
    const idA = this.order[ia];
    const idB = this.order[ib];
    if (idA === undefined || idB === undefined) return;
    this.order[ia] = idB;
    this.order[ib] = idA;
    PerAccountLocalStorage.getInstance().set(
      StorageKeys.FOCUS_UI_ORDER,
      this.order
    );
    this.applyOrderToGrid();
  }

  /** Mirror the stored order into the grid DOM (grid state only). */
  private applyOrderToGrid(): void {
    if (this.activeId || this.morphing) return;
    for (const id of this.order) {
      const circle = this.objects.get(id);
      if (circle) this.grid.appendChild(circle);
    }
  }

  /**
   * Re-parent the non-active circles into two per-side stacks (grid
   * columns 1 and 3). In one flat grid the active object's content height
   * would be distributed across all spanned rows (circles spread over
   * thousands of px); inside the stacks they keep their compact 230px
   * rhythm while the middle column stretches in document flow.
   */
  private reparentSideStacks(activeId: string): void {
    const left = document.createElement('div');
    left.className = 'focus-side-stack';
    left.dataset.focusStack = '';
    left.style.gridColumn = '1';
    const right = document.createElement('div');
    right.className = 'focus-side-stack';
    right.dataset.focusStack = '';
    right.style.gridColumn = '3';
    left.innerHTML = this.stackToolsHtml('left');
    right.innerHTML = this.stackToolsHtml('right');
    for (const [stack, side] of [
      [left, 'left'],
      [right, 'right'],
    ] as const) {
      // The buttons must never open an object underneath.
      const tools = stack.querySelector(
        '[data-focus-stack-tools]'
      ) as HTMLElement;
      tools.addEventListener('click', ev => ev.stopPropagation());
      const move = tools.querySelector(
        '[data-focus-stack-move]'
      ) as HTMLElement;
      move.addEventListener('pointerdown', ev => this.startStackDrag(ev, side));
      tools
        .querySelector('[data-focus-stack-compact]')
        ?.addEventListener('click', () => this.toggleStackCompact());
      tools
        .querySelector('[data-focus-stack-reset]')
        ?.addEventListener('click', () => this.resetStackSide());
      // Stack tools live only while their stack exists (recreated per
      // focus, removed on close) — their listeners die with the elements,
      // so no disposer tracking is needed here. The move tooltip states
      // the drop DIRECTION: dragging it toward the other column.
      const stackTips: Array<[string, HTMLElement]> = [
        [
          _('Compact circles'),
          tools.querySelector('[data-focus-stack-compact]') as HTMLElement,
        ],
        [
          side === 'left'
            ? _('Move all circles to the right column')
            : _('Move all circles to the left column'),
          move,
        ],
        [
          _('Distribute circles evenly'),
          tools.querySelector('[data-focus-stack-reset]') as HTMLElement,
        ],
        [
          _('Scroll down'),
          tools.querySelector('[data-focus-stack-scroll-down]') as HTMLElement,
        ],
        [
          _('Scroll up'),
          tools.querySelector('[data-focus-stack-scroll-up]') as HTMLElement,
        ],
      ];
      for (const [text, btn] of stackTips) Tooltip.attach(btn, text);
      // Stack-scoped scroll controls: PageDown/PageUp steps (one column
      // viewport per click), smooth. Keyboard scrolling deliberately
      // reaches only the middle column — these cover the side columns.
      // The buttons' sync dies with the stack (listeners on the stack),
      // same lifecycle as the other tools.
      const scrollStep = (): number => stack.clientHeight;
      tools
        .querySelector('[data-focus-stack-scroll-down]')
        ?.addEventListener('click', () =>
          stack.scrollBy({ top: scrollStep(), behavior: 'smooth' })
        );
      tools
        .querySelector('[data-focus-stack-scroll-up]')
        ?.addEventListener('click', () =>
          stack.scrollBy({ top: -scrollStep(), behavior: 'smooth' })
        );
      stack.addEventListener('scroll', () => this.syncStackScrollButtons(), {
        passive: true,
      });
    }
    this.distributeSideCircles(left, right, activeId);
    this.placeWidgets(left, right);
    const active = this.objects.get(activeId) as HTMLElement;
    this.grid.insertBefore(left, active);
    this.grid.insertBefore(right, active.nextSibling);
    this.sideStacks = [left, right];
    this.applyStackCompact();
    // Initial button state (stack is in the DOM now, geometry measurable).
    this.syncStackScrollButtons();
  }

  /**
   * Sync the stack scroll buttons with each stack's scroll position:
   * scroll-up exists only while scrolled away from the top (appears to
   * the right of scroll-down). Driven by the stacks' scroll events (the
   * only way scrollTop leaves 0 — wheel, drag or these buttons), after
   * mount and after the compact morph (which clamps scrollTop without a
   * user gesture). Scroll-down needs no state: at the bottom end its
   * click simply clamps, like the wheel.
   */
  private syncStackScrollButtons(): void {
    for (const stack of this.sideStacks ?? []) {
      const up = stack.querySelector(
        '[data-focus-stack-scroll-up]'
      ) as HTMLElement | null;
      if (!up) continue;
      up.hidden = stack.scrollTop <= 1;
    }
  }

  /** Toggle the side-stack compact rendering (circles → ED-b chips) and
   * persist the preference per account. */
  private toggleStackCompact(): void {
    this.stackCompact = !this.stackCompact;
    PerAccountLocalStorage.getInstance().set(
      StorageKeys.FOCUS_UI_STACK_COMPACT,
      this.stackCompact
    );
    this.applyStackCompact();
    diagLog('system', 'focus_stack_compact_toggled', {
      on: this.stackCompact,
    });
  }

  /** Apply the compact state to every live circle. The ACTIVE circle is
   * never compact — it is the focused column, not a stack item; the home
   * grid renders round again on close (restoreSideCircles clears the
   * class). The tools' compact buttons mirror the state (icon flips to
   * outward arrows via .is-active). */
  private applyStackCompact(): void {
    for (const [id, circle] of this.objects) {
      circle.classList.toggle(
        'is-compact',
        this.stackCompact && id !== this.activeId
      );
    }
    for (const stack of this.sideStacks ?? []) {
      stack
        .querySelector('[data-focus-stack-compact]')
        ?.classList.toggle('is-active', this.stackCompact);
    }
    // The morph changes every circle's height — the reachable scroll
    // range shifts without a scroll event, re-sync the scroll buttons.
    this.syncStackScrollButtons();
  }

  /** Apply the arrange gate: the root class keys the CSS that hides the
   * layout satellites while OFF (visibility, not display — the sticky
   * tools band keeps its height, no layout jump on toggle). */
  private applyArrangeGate(): void {
    this.root.classList.toggle('is-arrange-on', this.arrangeOn);
  }

  /** The stack's top tools: compact toggle (leftmost), move handle (drag
   * moves ALL circles) + reset (even distribution), then the stack's own
   * scroll controls (PageDown/PageUp steps — keyboard scrolling only
   * reaches the middle column). Scroll-up only exists while scrolled. */
  private stackToolsHtml(side: 'left' | 'right'): string {
    return `<div class="focus-side-stack__tools" data-focus-stack-tools>
      <button type="button" class="focus-side-stack__compact${
        this.stackCompact ? ' is-active' : ''
      }" data-focus-stack-compact aria-label="${_('Compact circles')}">
        <svg class="focus-side-stack__compact-icon-in" width="15" height="15" aria-hidden="true"><use href="#icon-compact"/></svg>
        <svg class="focus-side-stack__compact-icon-out" width="15" height="15" aria-hidden="true"><use href="#icon-compact-open"/></svg>
      </button>
      <button type="button" class="focus-side-stack__move" data-stack-side="${side}" data-focus-stack-move aria-label="${_('Move all circles')}">
        <svg width="15" height="15" aria-hidden="true"><use href="#icon-move"/></svg>
      </button>
      <button type="button" class="focus-side-stack__reset" data-focus-stack-reset aria-label="${_('Distribute circles evenly')}">
        <svg width="15" height="15" aria-hidden="true"><use href="#icon-pull-refresh"/></svg>
      </button>
      <button type="button" class="focus-side-stack__scroll-down" data-focus-stack-scroll-down aria-label="${_('Scroll down')}">
        <svg width="15" height="15" aria-hidden="true"><use href="#icon-chevron-down"/></svg>
      </button>
      <button type="button" class="focus-side-stack__scroll-up" data-focus-stack-scroll-up aria-label="${_('Scroll up')}" hidden>
        <svg width="15" height="15" aria-hidden="true"><use href="#icon-chevron-up"/></svg>
      </button>
    </div>`;
  }

  /**
   * Fill the two stacks with the non-active circles, in the order of the
   * effective column layout (persisted FOCUS_UI_COLUMN_LAYOUT or the
   * alternating default). The ACTIVE circle is skipped: it stays in the
   * center column but KEEPS its slot in the layout, so it returns to its
   * position when the focus ends.
   */
  private distributeSideCircles(
    left: HTMLElement,
    right: HTMLElement,
    activeId: string
  ): void {
    const layout = this.effectiveLayout();
    for (const [stack, ids] of [
      [left, layout.left],
      [right, layout.right],
    ] as const) {
      for (const id of ids) {
        if (id === activeId) continue;
        const circle = this.objects.get(id);
        if (circle) stack.appendChild(circle);
      }
    }
  }

  /** Move the circles back into the grid (stored order) and drop the stacks. */
  private restoreSideCircles(): void {
    if (!this.sideStacks) return;
    // Append EVERY circle in the stored order — including the one that
    // stayed in the grid as the focused column. appendChild moves it, so
    // the original order is restored exactly; re-appending only the
    // stacked circles would place them all AFTER the formerly active
    // object and shuffle the grid.
    for (const def of this.orderedDefs()) {
      const circle = this.objects.get(def.id);
      if (circle) this.grid.appendChild(circle);
    }
    for (const [, entry] of this.widgetHosts) {
      entry.widget.setFocusHost(null);
      entry.host.remove();
    }
    this.widgetHosts.clear();
    // Back in the home grid the circles render round again — the compact
    // preference re-applies to the stacks on the next focus.
    for (const [, circle] of this.objects) {
      circle.classList.remove('is-compact');
    }
    for (const stack of this.sideStacks) stack.remove();
    this.sideStacks = null;
  }

  /**
   * Shared FLIP used by open and close: every object animates from its
   * `first` geometry to the current (post-layout) one. Border-radius only
   * animates on the active object (circle → column radius → circle).
   */
  private async flipAll(first: Map<HTMLElement, DOMRect>): Promise<void> {
    const reduced = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches;
    const animations: Promise<unknown>[] = [];
    // In flow the active column can be far taller than the viewport —
    // animating the full height is wasted relayout work. Cap it at the
    // viewport bottom: the un-capped snap after the animation happens
    // entirely below the fold (invisible).
    const animHeight = (r: DOMRect): number =>
      r.top + r.height <= window.innerHeight
        ? r.height
        : Math.max(0, window.innerHeight - r.top);
    for (const el of this.objects.values()) {
      const firstRect = first.get(el);
      if (!firstRect) continue;
      const lastRect = el.getBoundingClientRect();
      // Anchor at the top-left corner: for equal-size circles this is
      // identical to center-to-center, but the active object grows
      // downward into its content height instead of flying off-screen.
      const dx = firstRect.left - lastRect.left;
      const dy = firstRect.top - lastRect.top;
      const frames: Keyframe[] = [
        {
          transform: `translate(${dx}px, ${dy}px)`,
          width: `${firstRect.width}px`,
          height: `${animHeight(firstRect)}px`,
        },
        {
          transform: 'translate(0, 0)',
          width: `${lastRect.width}px`,
          height: `${animHeight(lastRect)}px`,
        },
      ];
      if (el.classList.contains('focus-object--active')) {
        frames[0]!.borderRadius = '50%';
        frames[1]!.borderRadius = getComputedStyle(el).borderRadius;
      } else if (el.classList.contains('is-compact')) {
        // Compact chips measured as round circles (pre-reparent first
        // rects): animate the radius down with the height instead of
        // snapping to the chip's corner radius.
        frames[0]!.borderRadius = '50%';
      }
      const animation = el.animate(frames, {
        duration: reduced ? 0 : MORPH_MS,
        easing: MORPH_EASING,
      });
      animations.push(animation.finished.catch(() => undefined));
    }
    await Promise.all(animations);
  }

  private measureAll(): Map<HTMLElement, DOMRect> {
    // Force a synchronous layout so rects reflect the current grid state.
    void this.grid.offsetHeight;
    const rects = new Map<HTMLElement, DOMRect>();
    for (const el of this.objects.values()) {
      rects.set(el, el.getBoundingClientRect());
    }
    return rects;
  }

  private async ensureSurface(
    def: FocusDomainDef
  ): Promise<FocusDomainSurface> {
    let surface = this.surfaces.get(def.id);
    if (!surface && def.createSurface) {
      surface = await def.createSurface();
      this.surfaces.set(def.id, surface);
    }
    return surface as FocusDomainSurface;
  }
}
