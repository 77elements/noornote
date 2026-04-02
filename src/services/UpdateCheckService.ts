/**
 * UpdateCheckService
 * Checks GitHub Releases for new versions (Tauri desktop only)
 * Uses global localStorage (not per-account) for settings and cache
 */

import { compareVersions } from '../helpers/compareVersions';
import { PlatformService } from './PlatformService';

declare const __APP_VERSION__: string;

const STORAGE_KEYS = {
  AUTO_CHECK: 'noornote_auto_update_check',
  LAST_CHECK: 'noornote_last_update_check',
  SKIPPED_VERSION: 'noornote_skipped_version',
} as const;

const CHECK_INTERVAL = 5 * 60 * 60 * 1000; // 5 hours
const GITHUB_API_URL = 'https://api.github.com/repos/77elements/noornote/releases/latest';

export interface UpdateInfo {
  version: string;
  downloadUrl: string;
  releaseNotes: string;
  publishedAt: string;
}

interface GitHubRelease {
  tag_name?: string;
  html_url?: string;
  body?: string;
  published_at?: string;
}

export class UpdateCheckService {
  private static instance: UpdateCheckService;

  private constructor() {}

  public static getInstance(): UpdateCheckService {
    if (!UpdateCheckService.instance) {
      UpdateCheckService.instance = new UpdateCheckService();
    }
    return UpdateCheckService.instance;
  }

  /**
   * Check on app startup (respects interval and auto-check setting)
   */
  public async checkOnStartup(): Promise<void> {
    const platform = PlatformService.getInstance();
    if (!platform.isDesktop) return;
    if (!this.isAutoCheckEnabled()) return;

    const lastCheck = Number(localStorage.getItem(STORAGE_KEYS.LAST_CHECK) || '0');
    if (Date.now() - lastCheck < CHECK_INTERVAL) return;

    const update = await this.checkForUpdate();
    if (update) {
      const { UpdateModal } = await import('../components/modals/UpdateModal');
      new UpdateModal().show(update);
    }
  }

  /**
   * Check GitHub for latest release (called from startup or manually)
   */
  public async checkForUpdate(): Promise<UpdateInfo | null> {
    try {
      const release = await this.fetchLatestRelease();
      if (!release) return null;

      localStorage.setItem(STORAGE_KEYS.LAST_CHECK, String(Date.now()));

      const latestVersion = (release.tag_name || '').replace(/^v/, '');

      if (compareVersions(__APP_VERSION__, latestVersion) >= 0) {
        return null;
      }

      const skipped = localStorage.getItem(STORAGE_KEYS.SKIPPED_VERSION);
      if (skipped === latestVersion) return null;

      return this.buildUpdateInfo(release, latestVersion);
    } catch {
      return null;
    }
  }

  /**
   * Manual check triggered by user button (handles button state and toast/modal)
   */
  public async checkManually(button: HTMLButtonElement): Promise<void> {
    const originalText = button.textContent || '';
    button.disabled = true;
    button.textContent = 'Checking...';

    try {
      const update = await this.checkForUpdate();

      if (update) {
        const { UpdateModal } = await import('../components/modals/UpdateModal');
        new UpdateModal().show(update);
      } else {
        const { ToastService } = await import('./ToastService');
        ToastService.show('You are on the latest version', 'success');
      }
    } catch {
      const { ToastService } = await import('./ToastService');
      ToastService.show('Failed to check for updates', 'error');
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  /**
   * Skip a specific version (user clicked "Skip this version")
   */
  public skipVersion(version: string): void {
    localStorage.setItem(STORAGE_KEYS.SKIPPED_VERSION, version);
  }

  public isAutoCheckEnabled(): boolean {
    return localStorage.getItem(STORAGE_KEYS.AUTO_CHECK) !== 'false';
  }

  public setAutoCheckEnabled(enabled: boolean): void {
    localStorage.setItem(STORAGE_KEYS.AUTO_CHECK, String(enabled));
  }

  /**
   * DEV ONLY: Simulate an available update by fetching real GitHub release
   * but ignoring version comparison and skipped version.
   * Usage in console: window.__updateService.simulateUpdate()
   */
  public async simulateUpdate(): Promise<void> {
    try {
      const release = await this.fetchLatestRelease();
      if (!release) {
        console.error('GitHub API returned no release data');
        return;
      }

      const version = (release.tag_name || '').replace(/^v/, '');
      const update = this.buildUpdateInfo(release, version || '99.0.0');

      console.log('Simulating update:', update.version, '(current:', __APP_VERSION__ + ')');

      const { UpdateModal } = await import('../components/modals/UpdateModal');
      new UpdateModal().show(update);
    } catch (e) {
      console.error('simulateUpdate failed:', e);
    }
  }

  /**
   * Fetch latest release data from GitHub API
   */
  private async fetchLatestRelease(): Promise<GitHubRelease | null> {
    const response = await fetch(GITHUB_API_URL, {
      headers: { 'Accept': 'application/vnd.github.v3+json' },
    });

    if (!response.ok) return null;

    return await response.json();
  }

  /**
   * Build UpdateInfo from raw GitHub release data
   */
  private buildUpdateInfo(release: GitHubRelease, version: string): UpdateInfo {
    return {
      version,
      downloadUrl: release.html_url || `https://github.com/77elements/noornote/releases/tag/${release.tag_name}`,
      releaseNotes: release.body || '',
      publishedAt: release.published_at || '',
    };
  }
}
