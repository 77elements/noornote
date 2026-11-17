/**
 * AddonLoader — Single source of truth for addon lifecycle.
 *
 * Goal: "ADD-on" means the code is not in the bundle/RAM when the addon is OFF.
 * When ON, the heavy module is dynamically imported, initialized, and can be
 * cleanly destroyed (full teardown of listeners, intervals, DOM, caches).
 *
 * Architecture:
 *   - Each addon has a thin `src/addons/<id>/runtime.ts` exporting init/destroy.
 *   - AddonLoader dynamically imports the runtime only when enabled.
 *   - Core files NEVER statically import addon heavy code. They may import the
 *     cheap flag accessor from `src/addons/<id>/index.ts`, and at hook sites
 *     they call `AddonLoader.getInstance().isLoaded(id)` to branch behavior.
 *
 * Scope:
 *   - 11 of 13 addons migrate through AddonLoader.
 *   - `bookmarks` and `tribes` intentionally STAY OUT of AddonLoader — their
 *     managers live in `src/lists/*.ts` and are tightly coupled to
 *     AutoSyncService, which must remain byte-identical. They stay UI-gated
 *     only, as documented in `docs/todos/addons-true-lazy-loading.md`.
 *
 * Lifecycle semantics:
 *   - App bootstrap: `init()` wires listeners; does NOT load any addon yet.
 *   - On `user:login`: `refresh(pubkey)` brings every enabled addon to loaded
 *     state for that pubkey; previously-loaded addons for a different pubkey
 *     are destroyed first.
 *   - On `user:logout`: every loaded addon is destroyed.
 *   - On `<id>:addon-toggle` events: the single addon is loaded or destroyed.
 *   - All load/destroy per addon is serialized through a Promise chain to
 *     prevent overlapping lifecycle calls and race conditions.
 *
 * Destroy contract (per runtime.ts — enforce during review):
 *   Every `destroy()` MUST fully and synchronously complete:
 *     - removeEventListener for every addEventListener (same fn reference, same options)
 *     - clearInterval / clearTimeout for every setInterval / setTimeout
 *     - TypedEventBus.off() for every subscription id returned by .on()
 *     - detach / empty every DOM node the addon mounted
 *     - drop every cache/store reference so it becomes GC-eligible
 *     - set cancel flags so in-flight promises do not write post-destroy state
 *
 * Idempotency:
 *   - A second `init()` without an intervening `destroy()` is a no-op.
 *   - A `destroy()` on an un-loaded addon is a no-op.
 *
 * Diagnostic logging:
 *   - Area: 'addons'. Parsed by `diagnose/addons_lifecycle.py` (Phase 14).
 *   - Messages are additive; never rename existing ones (script compatibility).
 */

import { TypedEventBus } from '../core/TypedEventBus';
import type { AddonTogglePayload } from '../core/events';
import { diagLog } from '../services/DiagnosticLogger';
import { resetGlobalAddonEnabledFlags } from './addonEnabledStorage';

export interface AddonContext {
  /** Hex pubkey of the currently logged-in user, or null for read-only/anonymous. */
  pubkey: string | null;
  /** npub form for convenience (storage paths, logging). */
  npub: string | null;
  /** Shared TypedEventBus instance. Runtimes should track subscription ids and off() in destroy. */
  eventBus: TypedEventBus;
}

export interface AddonRuntime {
  /** Mount the addon. Called after the flag is verified ON and the module is loaded. */
  init(ctx: AddonContext): Promise<void>;
  /** Tear down the addon completely. MUST leave no listeners, intervals, or DOM behind. */
  destroy(): Promise<void>;
}

/** Factory that dynamically imports the runtime module. Returns its {init, destroy} exports. */
type RuntimeLoader = () => Promise<AddonRuntime>;

interface AddonLoaderEntry {
  id: string;
  isEnabled: () => boolean;
  load: RuntimeLoader;
  /**
   * Login auto-load gate (default: load whenever enabled). An addon may
   * narrow this to "only when its UI surfaces are actually in use" —
   * on-demand paths (ensureLoaded) are unaffected.
   */
  bootLoad?: () => boolean;
  /** Current runtime instance, or null when not loaded. */
  instance: AddonRuntime | null;
  /** Pubkey the current instance was initialized for (for account-switch detection). */
  loadedForPubkey: string | null;
  /** An unload op is queued but not yet executed (dedupes on-demand unload logs). */
  unloadPending: boolean;
  /**
   * A destroy op is queued but not yet executed. Checked at execution
   * time: ensureLoaded cancels a queued destroy by clearing this flag —
   * the op then no-ops instead of tearing the runtime out under a
   * freshly re-created surface (tab recreate race).
   */
  destroyQueued: boolean;
  /** Serialization chain: every lifecycle op for this addon appends here. */
  opChain: Promise<void>;
}

export class AddonLoader {
  private static instance: AddonLoader | null = null;
  private readonly eventBus: TypedEventBus;
  private readonly entries = new Map<string, AddonLoaderEntry>();
  private currentPubkey: string | null = null;
  private currentNpub: string | null = null;
  // Subscription ids are intentionally not stored: AddonLoader is a singleton
  // for the lifetime of the app; we never unsubscribe the bootstrap listeners.
  private initialized = false;

  private constructor() {
    this.eventBus = TypedEventBus.getInstance();
  }

  public static getInstance(): AddonLoader {
    if (!AddonLoader.instance) AddonLoader.instance = new AddonLoader();
    return AddonLoader.instance;
  }

  /**
   * Register an addon with the loader. Call this at module-eval time (no IO).
   * The loader() factory is only invoked when the addon is actually activated.
   */
  public register(entry: {
    id: string;
    isEnabled: () => boolean;
    load: RuntimeLoader;
    /** Narrow the login auto-load (default: always when enabled). */
    bootLoad?: () => boolean;
  }): void {
    if (this.entries.has(entry.id)) {
      diagLog('addons', 'addons_register_duplicate', { id: entry.id });
      return;
    }
    this.entries.set(entry.id, {
      id: entry.id,
      isEnabled: entry.isEnabled,
      load: entry.load,
      ...(entry.bootLoad && { bootLoad: entry.bootLoad }),
      instance: null,
      loadedForPubkey: null,
      unloadPending: false,
      destroyQueued: false,
      opChain: Promise.resolve(),
    });
    // Subscribe to the per-addon toggle event. AddonToggleView emits
    // `<id>:addon-toggle` with { enabled: boolean }.
    // Dynamic event name (one per addon id — every `<id>:addon-toggle` is
    // declared in events.ts, but TS can't narrow a runtime template literal
    // to the matching key). Downcast to the string-keyed base bus.
    (
      this.eventBus.on as unknown as (
        event: string,
        cb: (data?: AddonTogglePayload) => void
      ) => string
    )(`${entry.id}:addon-toggle`, data => {
      const enabled = !!(data && data.enabled);
      diagLog('addons', enabled ? 'addons_toggle_on' : 'addons_toggle_off', {
        id: entry.id,
      });
      if (enabled) {
        void this.activate(entry.id);
      } else {
        void this.deactivate(entry.id);
      }
    });
  }

  /**
   * Bootstrap. Wires login/logout listeners. Does NOT load any addon yet —
   * that happens on `user:login` (or immediately, if the caller passes a
   * current pubkey for session-restore).
   */
  public bootstrap(current?: {
    pubkey: string | null;
    npub: string | null;
  }): void {
    if (this.initialized) return;
    this.initialized = true;

    // Force every global addon-enabled fallback key OFF. The per-account value
    // is the authoritative state; a new account has none and therefore reads
    // OFF, so every addon starts disabled for a new user no matter what an
    // older build (or another account) left in the global key.
    resetGlobalAddonEnabledFlags();

    this.eventBus.on(
      'user:login',
      (data?: { pubkey?: string; npub?: string }) => {
        const pubkey = data?.pubkey ?? null;
        const npub = data?.npub ?? null;

        void this.handleLogin(pubkey, npub);
      }
    );
    this.eventBus.on('user:logout', () => {
      void this.handleLogout();
    });

    // Focus UI switch: re-evaluate every bootLoad gate under the new
    // interface — v1→v2 unloads login addons that classic auto-loads but
    // v2 keeps on-demand (analytics, bulk-delete, …); v2→v1 loads what
    // classic expects. Same idempotent path as login.
    this.eventBus.on('settings:focus-ui-changed', () => {
      if (!this.currentPubkey) return;
      void this.handleLogin(this.currentPubkey, this.currentNpub);
    });

    diagLog('addons', 'addons_boot_scan', {
      registered: Array.from(this.entries.keys()),
      enabled: Array.from(this.entries.values())
        .filter(e => {
          try {
            return e.isEnabled();
          } catch {
            return false;
          }
        })
        .map(e => e.id),
    });

    // If the session is already restored at bootstrap time, trigger initial load.
    if (current && current.pubkey) {
      void this.handleLogin(current.pubkey, current.npub);
    }
  }

  /**
   * Explicit refresh — ensures every enabled addon is loaded for the given
   * pubkey. Safe to call multiple times; addons that are already loaded for
   * this pubkey are skipped. Use as a fallback when the user:login event
   * may have fired before the listener was registered.
   */
  public refresh(pubkey: string, npub: string | null): void {
    void this.handleLogin(pubkey, npub);
  }

  /** True iff the addon is currently loaded and initialized. */
  public isLoaded(id: string): boolean {
    const entry = this.entries.get(id);
    return !!(entry && entry.instance);
  }

  /** Dev diagnostics (DevLoadMonitor): read-only load state of all addons. */
  public listLoadState(): Array<{
    id: string;
    loaded: boolean;
    enabled: boolean;
  }> {
    return Array.from(this.entries.values()).map(entry => ({
      id: entry.id,
      loaded: !!entry.instance,
      enabled: (() => {
        try {
          return entry.isEnabled();
        } catch {
          return false;
        }
      })(),
    }));
  }

  /** Access the live runtime instance, typed. Returns null if not loaded. */
  public getRuntime<T extends AddonRuntime = AddonRuntime>(
    id: string
  ): T | null {
    const entry = this.entries.get(id);
    return entry && entry.instance ? (entry.instance as T) : null;
  }

  // ========== Internal lifecycle ==========

  private buildContext(): AddonContext {
    return {
      pubkey: this.currentPubkey,
      npub: this.currentNpub,
      eventBus: this.eventBus,
    };
  }

  private async handleLogin(
    pubkey: string | null,
    npub: string | null
  ): Promise<void> {
    const prev = this.currentPubkey;
    this.currentPubkey = pubkey;
    this.currentNpub = npub;
    if (prev && pubkey && prev !== pubkey) {
      diagLog('addons', 'addons_account_switch', {
        fromPubkey: prev,
        toPubkey: pubkey,
      });
    }
    // For every enabled addon, ensure it is loaded for the current pubkey.
    // bootLoad narrows the auto-load (e.g. live-streams: only with its
    // widget on or a pinned background stream — otherwise pure on-demand).
    // For every loaded addon that was initialized for a different pubkey,
    // destroy and re-init.
    for (const entry of this.entries.values()) {
      const enabled =
        this.safeIsEnabled(entry) && (entry.bootLoad ? entry.bootLoad() : true);

      if (!enabled) {
        if (entry.instance) {
          entry.destroyQueued = true;
          this.enqueue(entry, () => this.runDestroy(entry));
        }
        continue;
      }
      if (entry.instance && entry.loadedForPubkey !== pubkey) {
        // Account switch: tear down, then bring up for the new pubkey.
        this.enqueue(entry, async () => {
          entry.destroyQueued = true;
          await this.runDestroy(entry);
          await this.runInit(entry);
        });
      } else if (!entry.instance) {
        this.enqueue(entry, () => this.runInit(entry));
      }
    }
  }

  private async handleLogout(): Promise<void> {
    this.currentPubkey = null;
    this.currentNpub = null;
    for (const entry of this.entries.values()) {
      if (entry.instance) {
        entry.destroyQueued = true;
        this.enqueue(entry, () => this.runDestroy(entry));
      }
    }
  }

  private async activate(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (!this.safeIsEnabled(entry)) {
      diagLog('addons', 'addons_skip_disabled', {
        id,
        reason: 'activate called but isEnabled() false',
      });
      return;
    }
    if (entry.instance) return;
    this.enqueue(entry, () => this.runInit(entry));
  }

  private async deactivate(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (!entry.instance) return;
    entry.destroyQueued = true;
    this.enqueue(entry, () => this.runDestroy(entry));
  }

  /**
   * On-demand activation (v2): load the addon regardless of the stored
   * user preference, for exactly as long as its functionality is being
   * used. Call sites pair this with deactivate() once the work is done
   * (e.g. the composer unloads Scheduled Posts after the schedule
   * instruction was accepted). Idempotent; serialized through the addon's
   * op chain. The returned promise settles when the load op completed.
   */
  public ensureLoaded(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve();
    // Recreate race: a destroy op is queued but not yet executed (the
    // previous view's teardown). Cancel it instead of no-oping —
    // otherwise the queued destroy tears the runtime out under the
    // freshly created view and nothing re-loads it.
    if (entry.instance && entry.destroyQueued) {
      entry.destroyQueued = false;
      entry.unloadPending = false;
      return entry.opChain;
    }
    if (entry.instance) return Promise.resolve();
    diagLog('addons', 'addons_on_demand_load', {
      id,
      pubkey: this.currentPubkey,
    });
    entry.unloadPending = false;
    this.enqueue(entry, () => this.runInit(entry));
    return entry.opChain;
  }

  /**
   * On-demand counterpart of ensureLoaded(): unload an addon that was
   * activated on demand. No-op when not loaded or unknown id. Call sites
   * should skip this when the addon is permanently user-enabled — a later
   * login refresh would just load it again.
   */
  public deactivateOnDemand(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || !entry.instance || entry.unloadPending) {
      return Promise.resolve();
    }
    diagLog('addons', 'addons_on_demand_unload', { id });
    entry.unloadPending = true;
    entry.destroyQueued = true;
    this.enqueue(entry, () => this.runDestroy(entry));
    return entry.opChain;
  }

  /** Append an op to the addon's serialized chain. Errors are caught and logged. */
  private enqueue(entry: AddonLoaderEntry, op: () => Promise<void>): void {
    entry.opChain = entry.opChain.then(op).catch(err => {
      diagLog('addons', 'addons_runtime_error', {
        id: entry.id,
        error: String(
          err && (err as Error).message ? (err as Error).message : err
        ),
        stack: (err as Error)?.stack ?? null,
      });
    });
  }

  private async runInit(entry: AddonLoaderEntry): Promise<void> {
    if (entry.instance) {
      return; // idempotent
    }
    const loadStart = performance.now();
    diagLog('addons', 'addons_load_start', {
      id: entry.id,
      pubkey: this.currentPubkey,
    });
    let runtime: AddonRuntime;
    try {
      runtime = await entry.load();
    } catch (err) {
      diagLog('addons', 'addons_load_error', {
        id: entry.id,
        pubkey: this.currentPubkey,
        error: String(
          err && (err as Error).message ? (err as Error).message : err
        ),
      });
      return;
    }
    const loadDur = Math.round(performance.now() - loadStart);
    diagLog('addons', 'addons_load_ok', {
      id: entry.id,
      pubkey: this.currentPubkey,
      durationMs: loadDur,
    });

    const initStart = performance.now();
    try {
      await runtime.init(this.buildContext());
    } catch (err) {
      diagLog('addons', 'addons_runtime_error', {
        id: entry.id,
        phase: 'init',
        error: String(
          err && (err as Error).message ? (err as Error).message : err
        ),
        stack: (err as Error)?.stack ?? null,
      });
      return;
    }
    entry.instance = runtime;
    entry.loadedForPubkey = this.currentPubkey;
    entry.unloadPending = false;
    const initDur = Math.round(performance.now() - initStart);
    diagLog('addons', 'addons_init_ok', {
      id: entry.id,
      pubkey: this.currentPubkey,
      durationMs: initDur,
    });
  }

  private async runDestroy(entry: AddonLoaderEntry): Promise<void> {
    // Superseded: a queued ensureLoaded canceled this destroy (recreate
    // race) — the runtime must stay up for its new user.
    if (!entry.destroyQueued) return;
    entry.destroyQueued = false;
    if (!entry.instance) return; // idempotent
    const start = performance.now();
    diagLog('addons', 'addons_destroy_start', { id: entry.id });
    const runtime = entry.instance;
    entry.instance = null;
    entry.loadedForPubkey = null;
    entry.unloadPending = false;
    try {
      await runtime.destroy();
    } catch (err) {
      diagLog('addons', 'addons_runtime_error', {
        id: entry.id,
        phase: 'destroy',
        error: String(
          err && (err as Error).message ? (err as Error).message : err
        ),
        stack: (err as Error)?.stack ?? null,
      });
      return;
    }
    const dur = Math.round(performance.now() - start);
    diagLog('addons', 'addons_destroy_ok', { id: entry.id, durationMs: dur });
  }

  private safeIsEnabled(entry: AddonLoaderEntry): boolean {
    try {
      return entry.isEnabled();
    } catch (err) {
      diagLog('addons', 'addons_runtime_error', {
        id: entry.id,
        phase: 'isEnabled',
        error: String(
          err && (err as Error).message ? (err as Error).message : err
        ),
      });
      return false;
    }
  }
}
