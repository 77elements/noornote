/**
 * Dev-only load monitor — RAM/relay accounting for the Focus-UI (v2) promise:
 * "What the user needs is loaded into RAM for as long as they need it."
 *
 * Answers the question "what is still running right now?" in the live app:
 * with the monitor enabled, call `__v2load()` in the dev console to dump
 * every active load carrier — live relay subscriptions, intervals, loaded
 * modules/addons, v1 remnants (MainLayout), and cached v2 surfaces.
 *
 * Toggle (persisted across reloads, dev builds only):
 *   `__loadmon.enable()` / `__loadmon.disable()` / `__loadmon.status()`
 *   boot param rescue hatch: `?loadmon=1` / `?loadmon=0`
 * When disabled the module is inert — no timer patch, zero overhead.
 * Enabled on reload, the timer wrappers are installed before app code runs,
 * so intervals/timeouts created at boot are tracked from the start.
 *
 * Dev builds only: dynamically imported from main.ts under
 * `import.meta.env.DEV`, so production bundles never ship this module.
 */

import {
  NostrTransport,
  type LiveSubSnapshot,
} from './transport/NostrTransport';
import { ModuleLoader } from '../core/ModuleLoader';
import { AddonLoader } from '../addons/AddonLoader';
import { ViewMountingService } from './ViewMountingService';
import { isFocusUiActive, isFocusUiEnabled } from '../helpers/focusUiSetting';

const STORAGE_KEY = 'noornote_load_monitor';

export type { LiveSubSnapshot };

export interface DevLoadSnapshot {
  /** Stored preference (may lag the applied mode — boot URL rewrites drop ?focusui=). */
  focusUi: boolean;
  /** The APPLIED interface mode (`ui--focus` class) — what the user sees. */
  focusUiActive: boolean;
  relaySubscriptions: LiveSubSnapshot[];
  intervals: Array<{ id: number; origin: string; ageMin: number }>;
  timeoutsActive: number;
  modules: { loaded: string[]; registered: number };
  addons: { loaded: string[]; registered: number };
  v1: { mainLayoutMounted: boolean; primaryContentChildren: number };
  sections: Record<string, unknown>;
}

interface TrackedInterval {
  id: number;
  origin: string;
  createdAt: number;
}

interface TrackedTimeout {
  origin: string;
}

const trackedIntervals = new Map<number, TrackedInterval>();
const trackedTimeouts = new Map<number, TrackedTimeout>();
/** Sections contributed by other layers (e.g. the v2 shell registers its cached surfaces). */
const sections = new Map<string, () => unknown>();
/** Whether the monitor switch was ON at boot (timer patch installed). */
let enabled = false;

/** Persisted monitor switch (dev tool — machine-local, not account data). */
export function isLoadMonitorEnabled(): boolean {
  const param = new URLSearchParams(window.location.search).get('loadmon');
  if (param === '1') return true;
  if (param === '0') return false;
  return localStorage.getItem(STORAGE_KEY) === '1';
}

function setLoadMonitorEnabled(enabled: boolean): void {
  if (enabled) localStorage.setItem(STORAGE_KEY, '1');
  else localStorage.removeItem(STORAGE_KEY);
  location.reload();
}

/**
 * Shell code (focusStage) cannot be imported from services (lint boundary),
 * so the shell pushes its own snapshot in here. No-op outside dev builds.
 */
export function registerDevLoadSection(
  id: string,
  provider: () => unknown
): void {
  sections.set(id, provider);
}

/** File:line of the first stack frame outside this module (skip Error line
 *  + the timer wrappers themselves, which always occupy the first frames). */
function captureOrigin(): string {
  const frames = new Error().stack?.split('\n') ?? [];
  const caller =
    frames.find(
      frame => frame.includes('.ts:') && !frame.includes('DevLoadMonitor')
    ) ??
    frames[frames.length - 1] ??
    'unknown';
  const match = caller.match(/([^/(\s]+\.ts):(\d+):\d+\)?$/);
  return match ? `${match[1]}:${match[2]}` : caller.trim();
}

/**
 * Wrap setInterval/setTimeout/clear* to keep a live registry of every timer
 * the app creates. Zero-touch: no call site changes, only while enabled.
 */
function patchTimers(): void {
  const origSetInterval = window.setInterval.bind(window);
  const origClearInterval = window.clearInterval.bind(window);
  const origSetTimeout = window.setTimeout.bind(window);
  const origClearTimeout = window.clearTimeout.bind(window);

  window.setInterval = ((
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ) => {
    const id = origSetInterval(handler, timeout, ...args) as unknown as number;
    trackedIntervals.set(id, {
      id,
      origin: captureOrigin(),
      createdAt: Date.now(),
    });
    return id;
  }) as typeof window.setInterval;

  window.clearInterval = ((id?: Parameters<typeof window.clearInterval>[0]) => {
    trackedIntervals.delete(id as number);
    return origClearInterval(id);
  }) as typeof window.clearInterval;

  window.setTimeout = ((
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ) => {
    const isFn = typeof handler === 'function';
    let id = 0;
    const wrapped: TimerHandler = isFn
      ? (...fnArgs: unknown[]) => {
          trackedTimeouts.delete(id);
          (handler as (...a: unknown[]) => void)(...fnArgs);
        }
      : handler;
    id = origSetTimeout(wrapped, timeout, ...args) as unknown as number;
    if (isFn) trackedTimeouts.set(id, { origin: captureOrigin() });
    return id;
  }) as typeof window.setTimeout;

  window.clearTimeout = ((id?: Parameters<typeof window.clearTimeout>[0]) => {
    trackedTimeouts.delete(id as number);
    return origClearTimeout(id);
  }) as typeof window.clearTimeout;
}

function gatherSnapshot(): DevLoadSnapshot {
  const transport = NostrTransport.getInstance();

  const modules = ModuleLoader.getInstance().listLoadState();
  const addons = AddonLoader.getInstance().listLoadState();
  const mainLayout = ViewMountingService.getInstance().getMainLayout();
  const primaryContent = document.querySelector('.primary-content');

  const sectionData: Record<string, unknown> = {};
  sections.forEach((provider, id) => {
    try {
      sectionData[id] = provider();
    } catch (error) {
      sectionData[id] = { error: String(error) };
    }
  });

  return {
    focusUi: isFocusUiEnabled(),
    focusUiActive: isFocusUiActive(),
    relaySubscriptions: transport.getLiveSubscriptionSnapshot(),
    intervals: Array.from(trackedIntervals.values()).map(entry => ({
      id: entry.id,
      origin: entry.origin,
      ageMin: Math.round((Date.now() - entry.createdAt) / 60000),
    })),
    timeoutsActive: trackedTimeouts.size,
    modules: {
      loaded: modules.filter(m => m.loaded).map(m => m.id),
      registered: modules.length,
    },
    addons: {
      loaded: addons.filter(a => a.loaded).map(a => a.id),
      registered: addons.length,
    },
    v1: {
      mainLayoutMounted: mainLayout !== null,
      primaryContentChildren: primaryContent?.childElementCount ?? 0,
    },
    sections: sectionData,
  };
}

function dumpLoadSnapshot(): DevLoadSnapshot {
  const snapshot = gatherSnapshot();

  console.groupCollapsed(
    `%c── Load snapshot (Focus UI: ${snapshot.focusUi ? 'ON' : 'OFF'}) ──`,
    'font-weight:bold'
  );

  console.groupCollapsed(
    `Relay subscriptions (live): ${snapshot.relaySubscriptions.length}`
  );
  console.table(snapshot.relaySubscriptions);
  console.groupEnd();

  console.groupCollapsed(`Intervals: ${snapshot.intervals.length} active`);
  console.table(snapshot.intervals);
  console.groupEnd();

  console.log(
    `Timeouts: ${snapshot.timeoutsActive} pending ` +
      `(executed ones are removed; growth = leak)`
  );

  console.log(
    `Modules loaded: ${snapshot.modules.loaded.length}/${snapshot.modules.registered}`,
    snapshot.modules.loaded
  );
  console.log(
    `Addons loaded: ${snapshot.addons.loaded.length}/${snapshot.addons.registered}`,
    snapshot.addons.loaded
  );

  console.log('v1 remnants:', snapshot.v1);

  Object.entries(snapshot.sections).forEach(([id, data]) => {
    console.log(`${id}:`, data);
  });

  console.groupEnd();
  return snapshot;
}

/** Console control surface: `__v2load()` dumps, `__loadmon` toggles. */
function exposeConsoleApi(): void {
  const scope = window as unknown as Record<string, unknown>;

  scope.__v2load = enabled
    ? dumpLoadSnapshot
    : () => {
        console.log(
          'Load monitor is off — run __loadmon.enable() (reloads the app).'
        );
        return null;
      };

  scope.__loadmon = {
    enable: () => setLoadMonitorEnabled(true),
    disable: () => setLoadMonitorEnabled(false),
    status: () => {
      console.log(
        `Load monitor: ${enabled ? 'ON' : 'OFF'} ` +
          `(persisted in localStorage "${STORAGE_KEY}", ` +
          'boot param ?loadmon=1|0 overrides once)'
      );
      if (enabled) dumpLoadSnapshot();
    },
  };
}

/**
 * Called from main.ts (dev builds): with the switch ON, install the timer
 * patch and the `__v2load` dumper; with it OFF, still expose `__loadmon`
 * so the console can switch it on. Production never reaches this.
 */
export function installDevLoadMonitorIfEnabled(): void {
  enabled = isLoadMonitorEnabled();
  if (enabled) patchTimers();
  exposeConsoleApi();
}
