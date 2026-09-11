/**
 * WebUpdateCheck - detects a freshly deployed web build and nudges the user to reload.
 *
 * Every build bakes a unique __BUILD_ID__ into the bundle (vite define) and writes the same
 * id to dist/version.json (buildIdPlugin in vite.config.ts). While the app runs, this service
 * re-fetches version.json from the same origin — with `cache: 'no-store'` plus a cache-buster,
 * so the browser cache can never serve a stale answer — and compares the ids. A mismatch means
 * the server now serves a newer build than this tab is running: the UI (MainLayout, which owns
 * the DOM — services never touch components) shows a non-dismissable "App updated" banner with
 * a Reload button. After the reload the new bundle's id matches and the banner never returns.
 *
 * Single-shot per tab: once detected, `updateAvailable` sticks for the tab's lifetime and all
 * further checks no-op — the banner can never re-appear repeatedly (the failure mode of the
 * 2026-05 manual-banner attempts). No localStorage on purpose: nothing must survive a reload.
 *
 * Web only (PlatformService.isBrowser — Electron has UpdateCheckService, Android ships APKs);
 * skipped in dev. Checks run on start, tab focus, visibilitychange and every 15 minutes.
 * Offline / 404 / malformed responses are silently ignored — users must never be nagged
 * because a check could not run.
 */

import { PlatformService } from './PlatformService';
import { diagLog } from './DiagnosticLogger';

const CHECK_INTERVAL_MS = 15 * 60_000;

/**
 * Pure show-condition: banner only when a live build id was successfully fetched AND it
 * differs from the id baked into the running bundle. Exported for unit testing.
 */
export function shouldShowUpdateBanner(
  runningId: string,
  liveId: string | null
): boolean {
  return liveId !== null && liveId !== runningId;
}

export class WebUpdateCheck {
  private static instance: WebUpdateCheck | null = null;

  static getInstance(): WebUpdateCheck {
    if (!WebUpdateCheck.instance)
      WebUpdateCheck.instance = new WebUpdateCheck();
    return WebUpdateCheck.instance;
  }

  private started = false;
  private updateAvailable = false;
  private timer: number | null = null;
  private onAvailable: (() => void) | null = null;

  private onFocus = () => void this.check();
  private onVisibility = () => {
    if (document.visibilityState === 'visible') void this.check();
  };

  /**
   * Web-only. Registers the UI callback and starts the checks. Idempotent; when the update
   * was already detected, the (new) callback fires immediately so a freshly mounted layout
   * still shows the banner.
   */
  start(onUpdateAvailable: () => void): void {
    const platform = PlatformService.getInstance();
    if (!platform.isBrowser || import.meta.env.DEV) return;

    if (this.started) {
      this.onAvailable = onUpdateAvailable;
      if (this.updateAvailable) onUpdateAvailable();
      return;
    }
    this.started = true;
    this.onAvailable = onUpdateAvailable;

    window.addEventListener('focus', this.onFocus);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.timer = window.setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    void this.check();
  }

  /** Sticky state: true once a newer deployed build was detected (single-shot per tab). */
  isUpdateAvailable(): boolean {
    return this.updateAvailable;
  }

  private async check(): Promise<void> {
    if (this.updateAvailable) return;
    let liveId: string | null = null;
    try {
      const res = await fetch(`/version.json?cb=${Date.now()}`, {
        cache: 'no-store',
      });
      if (res.ok) {
        const data: unknown = await res.json();
        liveId =
          typeof data === 'object' && data !== null && 'id' in data
            ? String((data as { id: unknown }).id)
            : null;
      }
    } catch {
      return; // Offline / network hiccup — never nag.
    }
    if (!shouldShowUpdateBanner(__BUILD_ID__, liveId)) return;

    this.updateAvailable = true;
    diagLog('system', 'web update banner: newer deployed build detected');
    this.onAvailable?.();
  }

  destroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    window.removeEventListener('focus', this.onFocus);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.started = false;
    this.updateAvailable = false;
    this.onAvailable = null;
    WebUpdateCheck.instance = null;
    diagLog('system', 'web update check destroyed');
  }
}
