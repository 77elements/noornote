/**
 * SettingsView Component
 * Coordination layer for settings sections
 *
 * @purpose Glues settings sections together with minimal coordination logic
 * @architecture Each section manages its own state and behavior
 */

import { View } from './View';
import { KeySignerClient } from '../../services/KeySignerClient';
import { SyncStatusBadge } from '../shared/SyncStatusBadge';
import { PlatformService } from '../../services/PlatformService';

// Section imports
import { RelaySettingsSection } from '../settings/RelaySettingsSection';
import { KeySignerSection } from '../settings/KeySignerSection';
import { MediaServerSection } from '../settings/MediaServerSection';
import { NWCSettingsSection } from '../settings/NWCSettingsSection';
import { PrivacySettingsSection } from '../settings/PrivacySettingsSection';
import { ListSettingsSection } from '../settings/ListSettingsSection';
import { CacheSettingsSection } from '../settings/CacheSettingsSection';
import { UISettingsSection } from '../settings/UISettingsSection';

export class SettingsView extends View {
  private container: HTMLElement;
  private keySignerClient: KeySignerClient | null = null;
  private syncStatusBadge: SyncStatusBadge | null = null;

  // Sections
  private relaySettingsSection: RelaySettingsSection;
  private keySignerSection: KeySignerSection | null = null;
  private mediaServerSection: MediaServerSection;
  private nwcSettingsSection: NWCSettingsSection;
  private privacySettingsSection: PrivacySettingsSection;
  private listSettingsSection: ListSettingsSection;
  private cacheSettingsSection: CacheSettingsSection;
  private uiSettingsSection: UISettingsSection;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'settings-view';

    // Initialize KeySigner client (Tauri only)
    if (PlatformService.getInstance().isTauri) {
      this.keySignerClient = KeySignerClient.getInstance();
    }

    // Initialize sections
    this.relaySettingsSection = new RelaySettingsSection();
    if (this.keySignerClient) {
      this.keySignerSection = new KeySignerSection(this.keySignerClient);
    }
    this.mediaServerSection = new MediaServerSection();
    this.nwcSettingsSection = new NWCSettingsSection();
    this.privacySettingsSection = new PrivacySettingsSection();
    this.listSettingsSection = new ListSettingsSection();
    this.cacheSettingsSection = new CacheSettingsSection();
    this.uiSettingsSection = new UISettingsSection();

    this.render();
  }

  /**
   * Initial render - creates accordion structure
   */
  private render(): void {
    this.container.innerHTML = `
      <div class="settings-container">
        <h1 class="settings-title">Settings</h1>
        <div id="sync-status-badge-container" class="sync-status-container"></div>

        ${this.relaySettingsSection.renderAccordionSection(
          'Relays settings',
          'Configure Nostr relay connections for storing and distributing events.',
          false
        )}

        ${this.keySignerSection ? this.keySignerSection.renderAccordionSection(
          'Key Signer',
          'Configure NoorSigner key signer for secure key management and autostart behavior.',
          false
        ) : ''}

        ${this.mediaServerSection.renderAccordionSection(
          'Media',
          'Configure media upload server and sensitive content display.',
          false
        )}

        ${this.nwcSettingsSection.renderAccordionSection(
          'Zaps',
          'Connect your Lightning wallet via Nostr Wallet Connect (NWC) to send zaps.',
          false
        )}

        ${this.privacySettingsSection.renderAccordionSection(
          'Privacy Settings',
          'Configure privacy settings for follow lists, bookmarks, and mutes (NIP-51 private lists).',
          false
        )}

        ${this.listSettingsSection.renderAccordionSection(
          'List Settings',
          'Configure how NoorNote syncs your lists (Follows, Bookmarks, Mutes) across local backup and relays.',
          false
        )}

        ${this.cacheSettingsSection.renderAccordionSection(
          'Cache Settings',
          'Configure NDK cache sizes and clear cache data.',
          false
        )}

        ${this.uiSettingsSection.renderAccordionSection(
          'UI Settings',
          'Configure UI behavior and experimental view navigation features.',
          false
        )}
      </div>
    `;

    // Bind accordion listeners once (they don't change)
    this.bindAccordionListeners();

    // Mount section content
    this.relaySettingsSection.mount(this.container);
    if (this.keySignerSection) {
      this.keySignerSection.mount(this.container);
    }
    this.mediaServerSection.mount(this.container);
    this.nwcSettingsSection.mount(this.container);
    this.privacySettingsSection.mount(this.container);
    this.listSettingsSection.mount(this.container);
    this.cacheSettingsSection.mount(this.container);
    this.uiSettingsSection.mount(this.container);

    // Initialize and mount sync status badge
    const badgeContainer = this.container.querySelector('#sync-status-badge-container');
    if (badgeContainer) {
      this.syncStatusBadge = new SyncStatusBadge(badgeContainer as HTMLElement);
      this.syncStatusBadge.subscribeToSyncStatus();
    }
  }

  /**
   * Bind accordion toggle listeners
   */
  private bindAccordionListeners(): void {
    const headers = this.container.querySelectorAll('.settings-section__header');
    headers.forEach(header => {
      header.addEventListener('click', (e) => {
        const section = (e.currentTarget as HTMLElement).closest('.settings-section');
        section?.classList.toggle('open');
      });
    });
  }

  /**
   * Get HTML element
   */
  public getElement(): HTMLElement {
    return this.container;
  }

  /**
   * Cleanup on destroy
   */
  public destroy(): void {
    this.relaySettingsSection.unmount();
    if (this.keySignerSection) {
      this.keySignerSection.unmount();
    }
    this.mediaServerSection.unmount();
    this.nwcSettingsSection.unmount();
    this.privacySettingsSection.unmount();
    this.listSettingsSection.unmount();
    this.cacheSettingsSection.unmount();
    this.uiSettingsSection.unmount();

    // Cleanup sync status badge
    if (this.syncStatusBadge) {
      this.syncStatusBadge.destroy();
      this.syncStatusBadge = null;
    }
  }
}
