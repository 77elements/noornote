/**
 * ModuleLoader — Generalized lifecycle manager for feature modules.
 *
 * Evolved from AddonLoader (which manages optional addons). ModuleLoader
 * extends the same pattern to ALL feature modules: views, services, and
 * functional domains like DMs, Zaps, Reactions, etc.
 *
 * Modules are lazy-loaded via dynamic import() and initialized only when
 * needed. When not active, they consume zero memory beyond a ~100 byte
 * registry entry ("sleeping").
 *
 * Activation modes:
 *   - 'login'  — loaded automatically on user:login
 *   - 'route'  — loaded when Router navigates to a matching path
 *   - 'manual' — loaded only via explicit ensure() call
 *
 * Sleep policies:
 *   - 'keep-alive'    — stays loaded after first init (default)
 *   - 'sleep-on-leave' — destroyed when user navigates away
 *   - 'manual'        — only destroyed on logout or explicit deactivate
 *
 * All lifecycle ops per module are serialized through a Promise chain,
 * identical to AddonLoader's pattern, preventing race conditions.
 *
 * Coexistence: ModuleLoader and AddonLoader run side by side during migration.
 * AddonLoader continues managing addons. ModuleLoader manages new feature modules.
 * They share the same TypedEventBus for login/logout events.
 */

import { TypedEventBus } from '../core/TypedEventBus';
import { diagLog } from '../services/DiagnosticLogger';

// ── Types ────────────────────────────────────────────────────

export interface ModuleContext {
  pubkey: string | null;
  npub: string | null;
  eventBus: TypedEventBus;
  require<T>(moduleId: string): Promise<T | null>;
}

export interface ModuleRuntime<TApi = unknown> {
  init(ctx: ModuleContext): Promise<void>;
  destroy(): Promise<void>;
  getApi?(): TApi;
}

export type ModuleActivation = 'login' | 'route' | 'manual';
export type ModuleSleepPolicy = 'keep-alive' | 'sleep-on-leave' | 'manual';

type RuntimeLoader = () => Promise<ModuleRuntime<unknown>>;

export interface ModuleRegistration {
  id: string;
  activation: ModuleActivation;
  routes?: string[];
  sleepPolicy?: ModuleSleepPolicy;
  isEnabled?: () => boolean;
  load: RuntimeLoader;
}

interface ModuleEntry {
  id: string;
  activation: ModuleActivation;
  routes: string[];
  sleepPolicy: ModuleSleepPolicy;
  isEnabled: () => boolean;
  load: RuntimeLoader;
  instance: ModuleRuntime<unknown> | null;
  loadedForPubkey: string | null;
  opChain: Promise<void>;
}

// ── ModuleLoader ─────────────────────────────────────────────

export class ModuleLoader {
  private static instance: ModuleLoader | null = null;
  private readonly eventBus: TypedEventBus;
  private readonly entries = new Map<string, ModuleEntry>();
  private currentPubkey: string | null = null;
  private currentNpub: string | null = null;
  private initialized = false;
  private currentRoute: string = '';

  private constructor() {
    this.eventBus = TypedEventBus.getInstance();
  }

  public static getInstance(): ModuleLoader {
    if (!ModuleLoader.instance) ModuleLoader.instance = new ModuleLoader();
    return ModuleLoader.instance;
  }

  // ── Registration ───────────────────────────────────────────

  public register(reg: ModuleRegistration): void {
    if (this.entries.has(reg.id)) {
      diagLog('system', 'module_register_duplicate', { id: reg.id });
      return;
    }
    this.entries.set(reg.id, {
      id: reg.id,
      activation: reg.activation,
      routes: reg.routes ?? [],
      sleepPolicy: reg.sleepPolicy ?? 'keep-alive',
      isEnabled: reg.isEnabled ?? (() => true),
      load: reg.load,
      instance: null,
      loadedForPubkey: null,
      opChain: Promise.resolve(),
    });
  }

  // ── Bootstrap ──────────────────────────────────────────────

  public bootstrap(current?: {
    pubkey: string | null;
    npub: string | null;
  }): void {
    if (this.initialized) return;
    this.initialized = true;

    this.eventBus.on(
      'user:login',
      (data?: { pubkey?: string; npub?: string }) => {
        void this.handleLogin(data?.pubkey ?? null, data?.npub ?? null);
      }
    );
    this.eventBus.on('user:logout', () => {
      void this.handleLogout();
    });

    window.addEventListener('router:navigate', (event: unknown) => {
      const path = (event as CustomEvent<{ path?: string }>).detail?.path;
      if (path) this.handleRouteChange(path);
    });

    diagLog('system', 'module_boot_scan', {
      registered: Array.from(this.entries.keys()),
    });

    if (current?.pubkey) {
      void this.handleLogin(current.pubkey, current.npub ?? null);
    }
  }

  public refresh(pubkey: string, npub: string | null): void {
    void this.handleLogin(pubkey, npub);
  }

  public async awaitReady(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      promises.push(entry.opChain);
    }
    await Promise.all(promises);
  }

  // ── Route-based activation ─────────────────────────────────

  public handleRouteChange(path: string): void {
    const previousRoute = this.currentRoute;
    this.currentRoute = path;

    for (const entry of this.entries.values()) {
      if (entry.activation !== 'route') continue;

      const matches = entry.routes.some(r => path.startsWith(r));
      const wasMatching = entry.routes.some(r => previousRoute.startsWith(r));

      if (matches && !entry.instance && this.safeIsEnabled(entry)) {
        this.enqueue(entry, () => this.runInit(entry));
      } else if (
        !matches &&
        wasMatching &&
        entry.instance &&
        entry.sleepPolicy === 'sleep-on-leave'
      ) {
        this.enqueue(entry, () => this.runDestroy(entry));
      }
    }
  }

  // ── Public API ─────────────────────────────────────────────

  public isLoaded(id: string): boolean {
    const entry = this.entries.get(id);
    return !!entry?.instance;
  }

  public getApi<T>(id: string): T | null {
    const entry = this.entries.get(id);
    if (!entry?.instance) return null;
    return (entry.instance.getApi?.() as T) ?? null;
  }

  public async ensure<T>(id: string): Promise<T | null> {
    const entry = this.entries.get(id);
    if (!entry) return null;

    if (entry.instance) {
      return (entry.instance.getApi?.() as T) ?? null;
    }

    if (!this.safeIsEnabled(entry)) return null;

    return new Promise<T | null>(resolve => {
      this.enqueue(entry, async () => {
        await this.runInit(entry);
        resolve((entry.instance?.getApi?.() as T) ?? null);
      });
    });
  }

  // ── Internal lifecycle ─────────────────────────────────────

  private buildContext(): ModuleContext {
    return {
      pubkey: this.currentPubkey,
      npub: this.currentNpub,
      eventBus: this.eventBus,
      require: <T>(moduleId: string) => this.ensure<T>(moduleId),
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
      diagLog('system', 'module_account_switch', { from: prev, to: pubkey });
    }

    for (const entry of this.entries.values()) {
      if (entry.activation !== 'login') continue;

      const enabled = this.safeIsEnabled(entry);

      if (!enabled) {
        if (entry.instance) {
          this.enqueue(entry, () => this.runDestroy(entry));
        }
        continue;
      }

      if (entry.instance && entry.loadedForPubkey !== pubkey) {
        this.enqueue(entry, async () => {
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
        this.enqueue(entry, () => this.runDestroy(entry));
      }
    }
  }

  private enqueue(entry: ModuleEntry, op: () => Promise<void>): void {
    entry.opChain = entry.opChain.then(op).catch(err => {
      diagLog('system', 'module_runtime_error', {
        id: entry.id,
        error: String(
          err && (err as Error).message ? (err as Error).message : err
        ),
        stack: (err as Error)?.stack ?? null,
      });
    });
  }

  private async runInit(entry: ModuleEntry): Promise<void> {
    if (entry.instance) return;

    const loadStart = performance.now();
    diagLog('system', 'module_load_start', {
      id: entry.id,
      pubkey: this.currentPubkey,
    });

    let runtime: ModuleRuntime<unknown>;
    try {
      runtime = await entry.load();
    } catch (err) {
      diagLog('system', 'module_load_error', {
        id: entry.id,
        error: String(
          err && (err as Error).message ? (err as Error).message : err
        ),
      });
      return;
    }

    const loadDur = Math.round(performance.now() - loadStart);
    diagLog('system', 'module_load_ok', { id: entry.id, durationMs: loadDur });

    const initStart = performance.now();
    try {
      await runtime.init(this.buildContext());
    } catch (err) {
      diagLog('system', 'module_runtime_error', {
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

    const initDur = Math.round(performance.now() - initStart);
    diagLog('system', 'module_init_ok', { id: entry.id, durationMs: initDur });
  }

  private async runDestroy(entry: ModuleEntry): Promise<void> {
    if (!entry.instance) return;

    const start = performance.now();
    diagLog('system', 'module_destroy_start', { id: entry.id });

    const runtime = entry.instance;
    entry.instance = null;
    entry.loadedForPubkey = null;

    try {
      await runtime.destroy();
    } catch (err) {
      diagLog('system', 'module_runtime_error', {
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
    diagLog('system', 'module_destroy_ok', { id: entry.id, durationMs: dur });
  }

  private safeIsEnabled(entry: ModuleEntry): boolean {
    try {
      return entry.isEnabled();
    } catch (err) {
      diagLog('system', 'module_runtime_error', {
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
