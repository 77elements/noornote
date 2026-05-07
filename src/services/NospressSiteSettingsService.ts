/**
 * NospressSiteSettingsService
 * Per-account CRUD for NosPress site-wide settings (SEO meta, theme
 * palette overrides, foreign code injection).
 *
 * Persisted locally; mirroring to relays via NospressSiteSettingsOrchestrator
 * is the caller's responsibility (call publishToRelays after save).
 */

import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';
import { EventBus } from './EventBus';
import {
  EMPTY_SITE_SETTINGS,
  type NospressSiteSettings,
} from '../addons/nospress/blocks/siteSettings';

export class NospressSiteSettingsService {
  private static instance: NospressSiteSettingsService | null = null;
  private eventBus: EventBus;

  private constructor() {
    this.eventBus = EventBus.getInstance();
  }

  public static getInstance(): NospressSiteSettingsService {
    if (!NospressSiteSettingsService.instance) {
      NospressSiteSettingsService.instance = new NospressSiteSettingsService();
    }
    return NospressSiteSettingsService.instance;
  }

  /** Release the singleton. See NospressService.destroy() for rationale. */
  public destroy(): void {
    NospressSiteSettingsService.instance = null;
  }

  public getSettings(): NospressSiteSettings {
    return PerAccountLocalStorage.getInstance().get<NospressSiteSettings>(
      StorageKeys.NOSPRESS_SITE_SETTINGS,
      EMPTY_SITE_SETTINGS
    );
  }

  public saveSettings(settings: NospressSiteSettings, opts?: { silent?: boolean }): void {
    PerAccountLocalStorage.getInstance().set(StorageKeys.NOSPRESS_SITE_SETTINGS, settings);
    if (!opts?.silent) {
      this.eventBus.emit('nospressSiteSettings:changed', { settings });
    }
  }

  /** Used by the orchestrator after a successful relay-fetch to update the
   *  local mirror without re-emitting the EventBus event (would cause
   *  unnecessary re-renders). */
  public setSettingsFromRelay(settings: NospressSiteSettings): void {
    PerAccountLocalStorage.getInstance().set(StorageKeys.NOSPRESS_SITE_SETTINGS, settings);
  }

  public clearSettings(): void {
    PerAccountLocalStorage.getInstance().remove(StorageKeys.NOSPRESS_SITE_SETTINGS);
    this.eventBus.emit('nospressSiteSettings:changed', { settings: EMPTY_SITE_SETTINGS });
  }
}
