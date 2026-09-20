/**
 * ReminderHub - the single platform-aware notification primitive for all addons.
 *
 * Generalized from the NostrMajlis pattern (the reference implementation).
 * Two paths, one API:
 *
 *  - Capacitor / Android: schedules OS-level local notifications via
 *    @capacitor/local-notifications — they fire even when the app is closed,
 *    auto-dismiss after `timeoutAfterMs` (NoorNote plugin patch →
 *    NotificationCompat.setTimeoutAfter) and can be cancelled per namespace.
 *  - Desktop / Web: `osNotifyNow` fires the web Notification API (permission
 *    gated, optional focus check). Native scheduling is a no-op here — the
 *    caller keeps its scan/AlertBar loop.
 *
 * Namespaces: every consumer registers exactly one namespace with a fixed ID
 * pool (idBase + poolSize). Pools are the collision guard between addons —
 * see the range table below; new addons take the next free range.
 *
 * ID ranges:
 *   majlis-prayer   90_000_000 (35)   majlis-holiday  90_001_000 (16)
 *   calendar        90_002_000 (64)   note-taking     90_003_000 (32)
 *   booking-owner   90_004_000 (32)   booking-guest   90_005_000 (32)
 *   ephemeral (osNotifyNow on Capacitor) 99_000_000+
 *
 * The App-Resume listener is owned here (one per app): on resume every
 * registered namespace is re-built and re-scheduled (debounced) — date
 * rollover, changed settings and refreshed data all funnel through
 * `rescheduleSoon()`.
 */

import { PlatformService } from '../PlatformService';

export interface ReminderSpec {
  /** Namespace-pool ID (from the hub's id allocation — never invent your own). */
  id: number;
  title: string;
  body: string;
  /** Epoch ms when the notification should fire. */
  fireAt: number;
  /** Android auto-dismiss after this many ms from posting (plugin patch). */
  timeoutAfterMs?: number;
  /** Fire during Doze — time-critical reminders only (default true). */
  allowWhileIdle?: boolean;
}

export interface ReminderNamespace {
  /** Unique pool name, e.g. 'calendar'. */
  name: string;
  idBase: number;
  poolSize: number;
  /**
   * Build the upcoming specs at reschedule time. Return [] when the addon is
   * disabled or nothing is upcoming — the hub then just cancels old IDs.
   */
  build: () => Promise<ReminderSpec[]>;
}

export interface OsNotifyOptions {
  /** Auto-dismiss on Android after this many ms. */
  timeoutAfterMs?: number;
  /**
   * Desktop/Web only: fire the OS notification only when NoorNote is not
   * focused ('unfocused', the NostrMajlis behavior), always, or never.
   * Capacitor always notifies (OS notifications show in the foreground).
   */
  osWhen?: 'always' | 'unfocused' | 'never';
  /**
   * Desktop/Web dedupe tag (the notification center replaces previous
   * notifications with the same tag). No effect on Capacitor.
   */
  tag?: string;
  /** Desktop/Web: auto-close the notification after this many ms. */
  autoCloseMs?: number;
  /** Desktop/Web click handler (runs after the hub focuses the window). */
  onClick?: () => void;
}

const RESCHEDULE_DEBOUNCE_MS = 600;
/** Ephemeral (immediate) OS notifications on Capacitor — not rescheduled. */
const EPHEMERAL_ID_BASE = 99_000_000;

/** Minimal Capacitor PluginListenerHandle shape (avoids importing types). */
interface ListenerHandle {
  remove: () => Promise<void>;
}

export class ReminderHub {
  private static instance: ReminderHub | null = null;

  public static getInstance(): ReminderHub {
    if (!ReminderHub.instance) {
      ReminderHub.instance = new ReminderHub();
    }
    return ReminderHub.instance;
  }

  public static resetInstance(): void {
    ReminderHub.instance = null;
  }

  private readonly namespaces = new Map<string, ReminderNamespace>();
  private readonly debounces = new Map<string, number>();
  private resumeHandle: ListenerHandle | null = null;
  private resumeInited = false;
  private ephemeralCounter = 0;

  public get isCapacitor(): boolean {
    return PlatformService.getInstance().isCapacitor;
  }

  /**
   * Lazy diagLog: keeps this module free of the DiagnosticLogger import chain
   * (AuthService → lists → DOM), so pure unit tests can load the hub.
   */
  private log(message: string, data?: Record<string, unknown>): void {
    void import('../DiagnosticLogger')
      .then(m => m.diagLog('system', message, data))
      .catch(() => {});
  }

  /**
   * Register a namespace pool. Call once at addon init (idempotent — a
   * re-registration replaces the builder, pools stay). On Capacitor this
   * arms the shared App-Resume listener on the first registration.
   */
  public registerNamespace(config: ReminderNamespace): void {
    this.namespaces.set(config.name, config);
    void this.initResumeListener();
  }

  /** Debounced rebuild+reschedule for one namespace (burst-safe). */
  public rescheduleSoon(name: string): void {
    if (!this.isCapacitor || !this.namespaces.has(name)) return;
    const existing = this.debounces.get(name);
    if (existing !== undefined) clearTimeout(existing);
    const handle = window.setTimeout(() => {
      this.debounces.delete(name);
      void this.rescheduleNow(name);
    }, RESCHEDULE_DEBOUNCE_MS);
    this.debounces.set(name, handle);
  }

  /** Cancel a namespace's pending native notifications (destroy contract). */
  public async cancelNamespace(name: string): Promise<void> {
    const pending = this.debounces.get(name);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.debounces.delete(name);
    }
    if (!this.isCapacitor) return;
    const { LocalNotifications } = await import(
      '@capacitor/local-notifications'
    );
    await LocalNotifications.cancel({ notifications: this.idsFor(name) }).catch(
      () => {}
    );
  }

  /** Pool IDs of a namespace (for LocalNotifications.cancel callers). */
  public idsFor(name: string): { id: number }[] {
    const config = this.namespaces.get(name);
    if (!config) return [];
    return Array.from({ length: config.poolSize }, (_, i) => ({
      id: config.idBase + i,
    }));
  }

  /**
   * Fire an OS notification NOW. Capacitor: LocalNotifications (also visible
   * in the foreground). Desktop/Web: web Notification API, gated by
   * permission and the `osWhen` focus rule.
   */
  public async osNotifyNow(options: {
    title: string;
    body: string;
    timeoutAfterMs?: number;
    osWhen?: 'always' | 'unfocused' | 'never';
    tag?: string;
    autoCloseMs?: number;
    onClick?: () => void;
  }): Promise<void> {
    const osWhen = options.osWhen ?? 'always';
    if (osWhen === 'never') return;

    if (this.isCapacitor) {
      const granted = await this.ensureNativePermission();
      if (!granted) return;
      const { LocalNotifications } = await import(
        '@capacitor/local-notifications'
      );
      const id = EPHEMERAL_ID_BASE + (this.ephemeralCounter++ % 1000);
      await LocalNotifications.schedule({
        notifications: [
          {
            id,
            title: options.title,
            body: options.body,
            schedule: { at: new Date(), allowWhileIdle: true },
            ...(options.tag ? { tag: options.tag } : {}),
            ...(options.timeoutAfterMs
              ? { extra: { timeoutAfter: options.timeoutAfterMs } }
              : {}),
          },
        ],
      }).catch(() => {});
      return;
    }

    if (
      typeof Notification === 'undefined' ||
      Notification.permission !== 'granted'
    ) {
      return;
    }
    if (osWhen === 'unfocused' && document.hasFocus()) return;
    try {
      const notification = new Notification(options.title, {
        body: options.body,
        ...(options.tag ? { tag: options.tag } : {}),
      });
      notification.onclick = () => {
        window.focus();
        options.onClick?.();
      };
      if (options.autoCloseMs) {
        window.setTimeout(() => {
          try {
            notification.close();
          } catch {
            // Already gone (tapped / dismissed) — nothing to clean up.
          }
        }, options.autoCloseMs);
      }
    } catch {
      // Some platforms throw on construction — nothing to salvage.
    }
  }

  /** Ask for native notification permission (Capacitor only). */
  public async ensureNativePermission(): Promise<boolean> {
    if (!this.isCapacitor) return false;
    const { LocalNotifications } = await import(
      '@capacitor/local-notifications'
    );
    let perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') {
      perm = await LocalNotifications.requestPermissions();
    }
    return perm.display === 'granted';
  }

  /** Release a namespace on addon destroy: cancel pending + drop config. */
  public async disposeNamespace(name: string): Promise<void> {
    await this.cancelNamespace(name);
    this.namespaces.delete(name);
  }

  /**
   * App-level teardown: remove the shared resume listener. Not used during
   * normal operation — the hub lives for the whole app lifetime.
   */
  public async shutdown(): Promise<void> {
    if (this.resumeHandle) {
      await this.resumeHandle.remove().catch(() => {});
      this.resumeHandle = null;
    }
    this.resumeInited = false;
  }

  // ---------- internals ----------

  private async initResumeListener(): Promise<void> {
    if (this.resumeInited || !this.isCapacitor) return;
    this.resumeInited = true;
    try {
      const { App } = await import('@capacitor/app');
      this.resumeHandle = await App.addListener('resume', () => {
        for (const name of this.namespaces.keys()) {
          this.rescheduleSoon(name);
        }
      });
    } catch {
      this.resumeInited = false;
    }
  }

  /** Cancel the namespace's old IDs, rebuild specs and schedule upcoming. */
  private async rescheduleNow(name: string): Promise<void> {
    if (!this.isCapacitor) return;
    const config = this.namespaces.get(name);
    if (!config) return;

    const { LocalNotifications } = await import(
      '@capacitor/local-notifications'
    );
    await LocalNotifications.cancel({ notifications: this.idsFor(name) }).catch(
      () => {}
    );

    let specs: ReminderSpec[] = [];
    try {
      specs = await config.build();
    } catch (error) {
      this.log('reminder-hub: build failed', {
        namespace: name,
        error: String(error).slice(0, 120),
      });
      return;
    }

    const valid = specs.filter(
      spec =>
        Number.isFinite(spec.fireAt) &&
        spec.fireAt > Date.now() &&
        config.idBase <= spec.id &&
        spec.id < config.idBase + config.poolSize
    );
    if (valid.length === 0) return;

    const granted = await this.ensureNativePermission();
    if (!granted) {
      this.log('reminder-hub: native permission denied', {
        namespace: name,
      });
      return;
    }

    await LocalNotifications.schedule({
      notifications: valid.map(spec => ({
        id: spec.id,
        title: spec.title,
        body: spec.body,
        schedule: {
          at: new Date(spec.fireAt),
          allowWhileIdle: spec.allowWhileIdle ?? true,
        },
        ...(spec.timeoutAfterMs
          ? { extra: { timeoutAfter: spec.timeoutAfterMs } }
          : {}),
      })),
    }).catch(() => {});

    this.log('reminder-hub: scheduled', {
      namespace: name,
      count: valid.length,
    });
  }
}
