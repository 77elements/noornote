/**
 * MediaServerSection Component
 * Manages media server configuration and NSFW display settings
 *
 * @purpose Configure media upload server (Blossom/NIP-96) and sensitive content display
 * @used-by SettingsView
 */

import { SettingsSection } from './SettingsSection';
import { Switch } from '../ui/Switch';
import { CustomDropdown } from '../ui/CustomDropdown';
import { ToastService } from '../../services/ToastService';
import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';

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


  private static readonly POPULAR_SERVERS = [
    { url: 'https://nostr.build', name: 'nostr.build (Most popular, NIP-96, free: 25 MiB)', protocol: 'nip96' as const, maxFileSize: 25 * 1024 * 1024 },
    { url: 'https://blossom.nostr.build', name: 'blossom.nostr.build (Blossom, free: 20 MiB)', protocol: 'blossom' as const, maxFileSize: 20 * 1024 * 1024 },
    { url: 'https://blossom.band', name: 'blossom.band (Blossom, free: 20 MiB)', protocol: 'blossom' as const, maxFileSize: 20 * 1024 * 1024 },
    { url: 'https://blossom.primal.net', name: 'blossom.primal.net (Blossom, free: 20 MiB)', protocol: 'blossom' as const, maxFileSize: 20 * 1024 * 1024 }
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
    return PerAccountLocalStorage.getInstance().get<MediaServerSettings>(
      StorageKeys.MEDIA_SERVER,
      { url: 'https://nostr.build', protocol: 'nip96' }
    );
  }

  /**
   * Save media server settings to storage
   */
  private saveMediaServerSettings(): void {
    PerAccountLocalStorage.getInstance().set(StorageKeys.MEDIA_SERVER, this.mediaServerSettings);
  }

  /**
   * Load sensitive media settings from storage
   */
  private loadSensitiveMediaSettings(): SensitiveMediaSettings {
    return PerAccountLocalStorage.getInstance().get<SensitiveMediaSettings>(StorageKeys.SENSITIVE_MEDIA, { displayNSFW: false });
  }

  /**
   * Save sensitive media settings to storage
   */
  private saveSensitiveMediaSettings(): void {
    PerAccountLocalStorage.getInstance().set(StorageKeys.SENSITIVE_MEDIA, this.sensitiveMediaSettings);
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
        <section class="section">
          ${this.renderMediaServer()}
        </section>

        <section class="section">
          ${this.renderSensitiveMedia()}
        </section>
    `;
  }

  /**
   * Render media server subsection
   */
  private renderMediaServer(): string {
    return `
        <div class="setting">
          <span class="setting__label">Media Server</span>
          <div class="setting__control" id="media-server-dropdown-mount"></div>
          <p class="setting__desc">Choose where to upload images, videos, and other media files. Noornote supports both Blossom and NIP-96 protocols.</p>
        </div>

        <div class="media-server-custom ${!MediaServerSection.POPULAR_SERVERS.some(s => s.url === this.mediaServerSettings.url) ? '' : 'hidden'}" id="custom-server-section">
          <label for="custom-media-server-url">Custom Server URL:</label>
          <input
            type="text"
            id="custom-media-server-url"
            class="input"
            placeholder="https://your-server.com"
            value="${!MediaServerSection.POPULAR_SERVERS.some(s => s.url === this.mediaServerSettings.url) ? this.mediaServerSettings.url : ''}"
          />
        </div>

    `;
  }

  /**
   * Render sensitive media subsection
   */
  private renderSensitiveMedia(): string {
    return `
        <div class="setting">
          <span class="setting__label">Sensitive Media</span>
          <div class="setting__control" id="sensitive-media-switch-container"></div>
          <p class="setting__desc">Control how sensitive content (NSFW) is displayed. When disabled, NSFW images and videos will be blurred.</p>
        </div>
    `;
  }

  /**
   * Setup media server dropdown
   */
  private setupMediaServerDropdown(contentContainer: HTMLElement): void {
    const mount = contentContainer.querySelector('#media-server-dropdown-mount');
    if (!mount) return;

    const popularServers = MediaServerSection.POPULAR_SERVERS;
    const options = [
      ...popularServers.map(s => ({ value: s.url, label: s.name })),
      { value: 'custom', label: 'Custom...' }
    ];

    const isCustom = !popularServers.some(s => s.url === this.mediaServerSettings.url);
    const selectedValue = isCustom ? 'custom' : this.mediaServerSettings.url;

    const dropdown = new CustomDropdown({
      options,
      selectedValue,
      onChange: (value) => {
        const customSection = contentContainer.querySelector('#custom-server-section');
        if (value === 'custom') {
          customSection?.classList.remove('hidden');
        } else {
          customSection?.classList.add('hidden');
          this.mediaServerSettings.url = value;

          const selectedServer = popularServers.find(s => s.url === value);
          const detectedProtocol = selectedServer?.protocol || this.getProtocolForServer(value);
          this.mediaServerSettings.protocol = detectedProtocol;
          this.mediaServerSettings.maxFileSize = selectedServer?.maxFileSize;

          this.saveMediaServerSettings();
          ToastService.show('Media server saved', 'success');
        }
      }
    });

    mount.appendChild(dropdown.getElement());
  }

  /**
   * Bind event listeners
   */
  private bindListeners(contentContainer: HTMLElement): void {
    this.setupMediaServerDropdown(contentContainer);
    this.bindMediaServerListeners(contentContainer);
    this.bindSensitiveMediaListeners(contentContainer);
  }

  /**
   * Bind media server event listeners
   */
  private bindMediaServerListeners(contentContainer: HTMLElement): void {
    const customInput = contentContainer.querySelector('#custom-media-server-url') as HTMLInputElement;

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
