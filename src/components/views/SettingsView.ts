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
import { CacheSettingsSection } from '../settings/CacheSettingsSection';
import { UISettingsSection } from '../settings/UISettingsSection';
import { NotificationPrioritySection } from '../settings/NotificationPrioritySection';

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
  private cacheSettingsSection: CacheSettingsSection | null = null;
  private uiSettingsSection: UISettingsSection;
  private notificationPrioritySection: NotificationPrioritySection;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--settings';

    // Initialize KeySigner client (desktop only, not mobile)
    const platform = PlatformService.getInstance();
    if (platform.isTauri && !platform.isAndroid) {
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
    if (platform.isTauri && !platform.isAndroid) {
      this.cacheSettingsSection = new CacheSettingsSection();
    }
    this.uiSettingsSection = new UISettingsSection();
    this.notificationPrioritySection = new NotificationPrioritySection();
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

        ${this.uiSettingsSection.renderAccordionSection(
          'UI Settings',
          'Configure UI behavior and experimental view navigation features.',
          false
        )}

        ${this.notificationPrioritySection.renderAccordionSection(
          'Notification Priorities',
          'Configure which notification types trigger which badge style (pulsing, solid, hollow).',
          false
        )}

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

        ${this.cacheSettingsSection ? this.cacheSettingsSection.renderAccordionSection(
          'Cache Settings',
          'Configure NDK cache sizes and clear cache data.',
          false
        ) : ''}

        ${PlatformService.getInstance().isTauri ? `
        <section class="settings-section diagnostic-export-section" style="text-align: center;">
          <button class="btn btn--medium btn--passive" id="export-diagnostic-logs-btn">
            Export Logs
          </button>
        </section>
        ` : ''}
      </div>
    `;

    // Bind accordion listeners once (they don't change)
    this.bindAccordionListeners();

    // Mount section content
    this.uiSettingsSection.mount(this.container);
    this.notificationPrioritySection.mount(this.container);
    this.relaySettingsSection.mount(this.container);
    if (this.keySignerSection) {
      this.keySignerSection.mount(this.container);
    }
    this.mediaServerSection.mount(this.container);
    this.nwcSettingsSection.mount(this.container);
    this.privacySettingsSection.mount(this.container);
    if (this.cacheSettingsSection) {
      this.cacheSettingsSection.mount(this.container);
    }

    // Diagnostic logs export button
    this.container.querySelector('#export-diagnostic-logs-btn')?.addEventListener('click', async (e) => {
      const btn = e.target as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = 'Exporting...';
      try {
        const { exportDiagnosticLogs } = await import('../../services/DiagLogExportService');
        const { DiagnosticLogger } = await import('../../services/DiagnosticLogger');
        const status = DiagnosticLogger.getInstance().getStatus();
        const { ToastService } = await import('../../services/ToastService');

        if (!status.initialized) {
          const reason = status.error || 'Logger not initialized';
          ToastService.show(`DiagLog: ${reason}`, 'error', 8000);
          return;
        }

        let exportError: string | null = null;
        let success = false;
        try {
          success = await exportDiagnosticLogs();
        } catch (e) {
          exportError = String(e);
        }

        if (success) {
          ToastService.show('Logs exported', 'success');
        } else {
          const debugInfo = (exportDiagnosticLogs as any).lastDebugInfo || '';
          ToastService.show(exportError || debugInfo || 'export returned false', 'error', 15000);
        }
      } catch (error) {
        const { ToastService } = await import('../../services/ToastService');
        ToastService.show(`Import error: ${error}`, 'error', 15000);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Export Logs';
      }
    });

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
    const headers = this.container.querySelectorAll('.nn-ui-toggle__header');
    headers.forEach(header => {
      header.addEventListener('click', (e) => {
        const section = (e.currentTarget as HTMLElement).closest('.settings-section, .nn-ui-toggle');
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
    if (this.cacheSettingsSection) {
      this.cacheSettingsSection.unmount();
    }
    this.uiSettingsSection.unmount();
    this.notificationPrioritySection.unmount();

    // Cleanup sync status badge
    if (this.syncStatusBadge) {
      this.syncStatusBadge.destroy();
      this.syncStatusBadge = null;
    }
  }
}
