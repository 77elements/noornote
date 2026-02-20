/**
 * MediaServerSection Component
 * Manages media server configuration and NSFW display settings
 *
 * @purpose Configure media upload server (Blossom/NIP-96) and sensitive content display
 * @used-by SettingsView
 */

import { SettingsSection } from './SettingsSection';
import { Switch } from '../ui/Switch';
import { ToastService } from '../../services/ToastService';

interface MediaServerSettings {
  url: string;
  protocol: 'blossom' | 'nip96';
  maxFileSize?: number | undefined;
}

interface SensitiveMediaSettings {
  displayNSFW: boolean;
}

export class MediaServerSection extends SettingsSection {
  private mediaServerSettings: MediaServerSettings;
  private sensitiveMediaSettings: SensitiveMediaSettings;
  private readonly mediaServerStorageKey = 'noornote_media_server';
  private readonly sensitiveMediaStorageKey = 'noornote_sensitive_media';

  private static readonly POPULAR_SERVERS = [
    { url: 'https://nostr.build', name: 'nostr.build (Most popular, NIP-96)', protocol: 'nip96' as const, maxFileSize: 25 * 1024 * 1024 },
    { url: 'https://blossom.nostr.build', name: 'blossom.nostr.build (Blossom, 100 MiB)', protocol: 'blossom' as const, maxFileSize: 100 * 1024 * 1024 },
    { url: 'https://blossom.band', name: 'blossom.band (Blossom, 50 MiB)', protocol: 'blossom' as const, maxFileSize: 50 * 1024 * 1024 },
    { url: 'https://blossom.primal.net', name: 'blossom.primal.net (Blossom)', protocol: 'blossom' as const, maxFileSize: 100 * 1024 * 1024 }
  ];

  constructor() {
    super('media');
    this.mediaServerSettings = this.loadMediaServerSettings();
    this.sensitiveMediaSettings = this.loadSensitiveMediaSettings();
  }

  /**
   * Load media server settings from storage
   */
  private loadMediaServerSettings(): MediaServerSettings {
    try {
      const stored = localStorage.getItem(this.mediaServerStorageKey);
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (error) {
      console.debug('Failed to load media server settings:', error);
    }

    return {
      url: 'https://blossom.nostr.build',
      protocol: 'blossom'
    };
  }

  /**
   * Save media server settings to storage
   */
  private saveMediaServerSettings(): void {
    try {
      localStorage.setItem(this.mediaServerStorageKey, JSON.stringify(this.mediaServerSettings));
    } catch (error) {
      console.debug('Failed to save media server settings:', error);
    }
  }

  /**
   * Load sensitive media settings from storage
   */
  private loadSensitiveMediaSettings(): SensitiveMediaSettings {
    try {
      const stored = localStorage.getItem(this.sensitiveMediaStorageKey);
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (error) {
      console.debug('Failed to load sensitive media settings:', error);
    }

    return { displayNSFW: false };
  }

  /**
   * Save sensitive media settings to storage
   */
  private saveSensitiveMediaSettings(): void {
    try {
      localStorage.setItem(this.sensitiveMediaStorageKey, JSON.stringify(this.sensitiveMediaSettings));
    } catch (error) {
      console.debug('Failed to save sensitive media settings:', error);
    }
  }

  /**
   * Get protocol for known servers
   */
  private getProtocolForServer(url: string): 'blossom' | 'nip96' {
    const blossomServers = [
      'blossom.nostr.build',
      'blossom.band',
      'blossom.primal.net'
    ];

    const nip96Servers = [
      'nostr.build',
      'image.nostr.build'
    ];

    if (blossomServers.some(server => url.includes(server))) {
      return 'blossom';
    }

    if (nip96Servers.some(server => url.includes(server))) {
      return 'nip96';
    }

    return 'nip96';
  }

  /**
   * Mount section content into the DOM
   */
  public mount(parentContainer: HTMLElement): void {
    const contentContainer = this.getContentContainer(parentContainer);
    if (!contentContainer) return;

    contentContainer.innerHTML = this.renderContent();
    this.bindListeners(contentContainer);
  }

  /**
   * Render media settings content
   */
  private renderContent(): string {
    return `
        <!-- Media Server Subsection -->
        <div class="media-subsection">
          <h3 class="subsection-title">Media Server</h3>
          ${this.renderMediaServer()}
        </div>

        <!-- Sensitive Media Subsection -->
        <div class="media-subsection">
          <h3 class="subsection-title">Sensitive Media</h3>
          ${this.renderSensitiveMedia()}
        </div>
    `;
  }

  /**
   * Render media server subsection
   */
  private renderMediaServer(): string {
    const popularServers = MediaServerSection.POPULAR_SERVERS;

    return `
        <div class="form__info">
          <p>Choose where to upload images, videos, and other media files. Noornote supports both Blossom and NIP-96 protocols.</p>
        </div>

        <div class="form__row form__row--oneline">
          <label for="media-server-url">Media Server:</label>
          <select id="media-server-url">
            ${popularServers.map(server => `
              <option value="${server.url}" ${this.mediaServerSettings.url === server.url ? 'selected' : ''}>
                ${server.name}
              </option>
            `).join('')}
            <option value="custom" ${!popularServers.some(s => s.url === this.mediaServerSettings.url) ? 'selected' : ''}>
              Custom...
            </option>
          </select>
        </div>

        <div class="media-server-custom ${!popularServers.some(s => s.url === this.mediaServerSettings.url) ? '' : 'hidden'}" id="custom-server-section">
          <label for="custom-media-server-url">Custom Server URL:</label>
          <input
            type="text"
            id="custom-media-server-url"
            class="media-server-input"
            placeholder="https://your-server.com"
            value="${!popularServers.some(s => s.url === this.mediaServerSettings.url) ? this.mediaServerSettings.url : ''}"
          />
        </div>

        <div class="form__row">
          <label>Protocol:</label>
          <div class="protocol-switch">
            <button
              class="protocol-btn ${this.mediaServerSettings.protocol === 'blossom' ? 'active' : ''}"
              data-protocol="blossom"
            >
              Blossom
            </button>
            <button
              class="protocol-btn ${this.mediaServerSettings.protocol === 'nip96' ? 'active' : ''}"
              data-protocol="nip96"
            >
              NIP-96
            </button>
          </div>
          <p class="form__note">Most servers auto-detect. Use Blossom for newer servers, NIP-96 for legacy.</p>
        </div>
    `;
  }

  /**
   * Render sensitive media subsection
   */
  private renderSensitiveMedia(): string {
    return `
        <div class="form__info">
          <p>Control how sensitive content (NSFW) is displayed. When disabled, NSFW images and videos will be blurred.</p>
        </div>

        <div class="sensitive-media-switch-container" id="sensitive-media-switch-container">
          <!-- Switch will be mounted here -->
        </div>
    `;
  }

  /**
   * Bind event listeners
   */
  private bindListeners(contentContainer: HTMLElement): void {
    this.bindMediaServerListeners(contentContainer);
    this.bindSensitiveMediaListeners(contentContainer);
  }

  /**
   * Bind media server event listeners
   */
  private bindMediaServerListeners(contentContainer: HTMLElement): void {
    const dropdown = contentContainer.querySelector('#media-server-url') as HTMLSelectElement;
    const customSection = contentContainer.querySelector('#custom-server-section');
    const customInput = contentContainer.querySelector('#custom-media-server-url') as HTMLInputElement;

    dropdown?.addEventListener('change', () => {
      if (dropdown.value === 'custom') {
        customSection?.classList.remove('hidden');
      } else {
        customSection?.classList.add('hidden');
        this.mediaServerSettings.url = dropdown.value;

        const selectedServer = MediaServerSection.POPULAR_SERVERS.find(s => s.url === dropdown.value);
        const detectedProtocol = selectedServer?.protocol || this.getProtocolForServer(dropdown.value);
        this.mediaServerSettings.protocol = detectedProtocol;
        this.mediaServerSettings.maxFileSize = selectedServer?.maxFileSize;

        const protocolButtons = contentContainer.querySelectorAll('.protocol-btn');
        protocolButtons.forEach(btn => {
          const btnProtocol = (btn as HTMLElement).dataset.protocol;
          if (btnProtocol === detectedProtocol) {
            btn.classList.add('active');
          } else {
            btn.classList.remove('active');
          }
        });

        this.saveMediaServerSettings();
        ToastService.show('Media server saved', 'success');
      }
    });

    const saveCustomUrl = () => {
      const url = customInput?.value.trim();
      if (!url) return;
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        ToastService.show('URL must start with http:// or https://', 'error');
        return;
      }
      this.mediaServerSettings.url = url;
      this.saveMediaServerSettings();
      ToastService.show('Media server saved', 'success');
    };

    customInput?.addEventListener('blur', saveCustomUrl);
    customInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveCustomUrl();
    });

    const protocolButtons = contentContainer.querySelectorAll('.protocol-btn');
    protocolButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const button = e.currentTarget as HTMLElement;
        const protocol = button.dataset.protocol as 'blossom' | 'nip96';

        if (!protocol) return;

        this.mediaServerSettings.protocol = protocol;

        protocolButtons.forEach(b => b.classList.remove('active'));
        button.classList.add('active');

        this.saveMediaServerSettings();
        ToastService.show(`Protocol set to ${protocol === 'blossom' ? 'Blossom' : 'NIP-96'}`, 'success');
      });
    });
  }

  /**
   * Bind sensitive media event listeners
   */
  private bindSensitiveMediaListeners(contentContainer: HTMLElement): void {
    const switchContainer = contentContainer.querySelector('#sensitive-media-switch-container');
    if (!switchContainer) return;

    const nsfwSwitch = new Switch({
      label: 'Display sensitive media',
      checked: this.sensitiveMediaSettings.displayNSFW,
      onChange: (checked) => {
        this.sensitiveMediaSettings.displayNSFW = checked;
        this.saveSensitiveMediaSettings();

        window.dispatchEvent(new CustomEvent('nsfw-preference-changed', {
          detail: { displayNSFW: checked }
        }));

        ToastService.show(checked ? 'Sensitive media will be shown' : 'Sensitive media will be blurred', 'success');
      }
    });

    switchContainer.innerHTML = nsfwSwitch.render();
    nsfwSwitch.setupEventListeners(switchContainer as HTMLElement);
  }

  /**
   * Unmount section and cleanup
   */
  public unmount(): void {
    // Cleanup if needed
  }
}
