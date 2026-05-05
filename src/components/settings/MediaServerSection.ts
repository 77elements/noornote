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
import {
  DEFAULT_MEDIA_COMPRESSION_SETTINGS,
  type CompressionQuality,
  type MaxResolution,
  type MediaCompressionSettings,
} from '../../services/media/compression-types';

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
  private compressionSettings: MediaCompressionSettings;


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
    this.compressionSettings = this.loadCompressionSettings();
  }

  private loadCompressionSettings(): MediaCompressionSettings {
    const stored = PerAccountLocalStorage.getInstance().get<MediaCompressionSettings>(
      StorageKeys.MEDIA_COMPRESSION,
      DEFAULT_MEDIA_COMPRESSION_SETTINGS,
    );
    // Merge with defaults so newer fields backfill on existing accounts.
    return {
      video: { ...DEFAULT_MEDIA_COMPRESSION_SETTINGS.video, ...stored.video },
      audio: { ...DEFAULT_MEDIA_COMPRESSION_SETTINGS.audio, ...stored.audio },
      minSizeBytes: stored.minSizeBytes ?? DEFAULT_MEDIA_COMPRESSION_SETTINGS.minSizeBytes,
    };
  }

  private saveCompressionSettings(): void {
    PerAccountLocalStorage.getInstance().set(StorageKeys.MEDIA_COMPRESSION, this.compressionSettings);
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
          ${this.renderMediaCompression()}
        </section>

        <section class="section">
          ${this.renderSensitiveMedia()}
        </section>
    `;
  }

  private renderMediaCompression(): string {
    const minMb = Math.round(this.compressionSettings.minSizeBytes / (1024 * 1024));
    return `
        <div class="setting">
          <span class="setting__label">Media Compression</span>
          <p class="setting__desc">
            Videos and audio are compressed locally using your device's hardware encoder (WebCodecs)
            before upload. Significantly reduces file size and saves CDN bandwidth — your media never
            leaves your device until upload.
          </p>

          <div class="setting__control" id="compress-video-switch-mount"></div>
          <div class="compression-detail" id="compress-video-detail">
            <div class="form__row form__row--oneline">
              <label>Quality</label>
              <div id="compress-video-quality-mount"></div>
            </div>
            <div class="form__row form__row--oneline">
              <label>Max resolution</label>
              <div id="compress-video-resolution-mount"></div>
            </div>
          </div>

          <div class="setting__control" id="compress-audio-switch-mount"></div>
          <div class="compression-detail" id="compress-audio-detail">
            <div class="form__row form__row--oneline">
              <label>Quality</label>
              <div id="compress-audio-quality-mount"></div>
            </div>
          </div>

          <div class="form__row form__row--oneline">
            <label>Skip compression for files below</label>
            <input
              type="number"
              class="input compression-min-size"
              id="compression-min-size-input"
              min="1"
              max="100"
              step="1"
              value="${minMb}"
            /> MB
          </div>
        </div>
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
    this.bindCompressionListeners(contentContainer);
    this.bindSensitiveMediaListeners(contentContainer);
  }

  private bindCompressionListeners(contentContainer: HTMLElement): void {
    const qualityOptions = [
      { value: 'low', label: 'Low (smallest size)' },
      { value: 'medium', label: 'Medium (recommended)' },
      { value: 'high', label: 'High' },
      { value: 'ultra', label: 'Ultra (near-zero quality loss)' },
    ];
    const resolutionOptions = [
      { value: '480', label: '480p' },
      { value: '720', label: '720p (HD)' },
      { value: '1080', label: '1080p (Full HD)' },
      { value: '0', label: 'Original' },
    ];

    // ---- Video toggle + detail panel
    const videoSwitchMount = contentContainer.querySelector('#compress-video-switch-mount') as HTMLElement | null;
    const videoDetail = contentContainer.querySelector('#compress-video-detail') as HTMLElement | null;
    const videoQualityMount = contentContainer.querySelector('#compress-video-quality-mount') as HTMLElement | null;
    const videoResolutionMount = contentContainer.querySelector('#compress-video-resolution-mount') as HTMLElement | null;

    if (videoSwitchMount) {
      const sw = new Switch({
        label: 'Compress videos before upload',
        checked: this.compressionSettings.video.enabled,
        onChange: (checked) => {
          this.compressionSettings.video.enabled = checked;
          this.saveCompressionSettings();
          if (videoDetail) videoDetail.classList.toggle('hidden', !checked);
        },
      });
      videoSwitchMount.innerHTML = sw.render();
      sw.setupEventListeners(videoSwitchMount);
    }
    if (videoDetail) videoDetail.classList.toggle('hidden', !this.compressionSettings.video.enabled);

    if (videoQualityMount) {
      const dropdown = new CustomDropdown({
        options: qualityOptions,
        selectedValue: this.compressionSettings.video.quality,
        onChange: (value) => {
          this.compressionSettings.video.quality = value as CompressionQuality;
          this.saveCompressionSettings();
        },
      });
      videoQualityMount.appendChild(dropdown.getElement());
    }
    if (videoResolutionMount) {
      const dropdown = new CustomDropdown({
        options: resolutionOptions,
        selectedValue: String(this.compressionSettings.video.maxResolution),
        onChange: (value) => {
          this.compressionSettings.video.maxResolution = Number(value) as MaxResolution;
          this.saveCompressionSettings();
        },
      });
      videoResolutionMount.appendChild(dropdown.getElement());
    }

    // ---- Audio toggle + detail panel
    const audioSwitchMount = contentContainer.querySelector('#compress-audio-switch-mount') as HTMLElement | null;
    const audioDetail = contentContainer.querySelector('#compress-audio-detail') as HTMLElement | null;
    const audioQualityMount = contentContainer.querySelector('#compress-audio-quality-mount') as HTMLElement | null;

    if (audioSwitchMount) {
      const sw = new Switch({
        label: 'Compress audio before upload',
        checked: this.compressionSettings.audio.enabled,
        onChange: (checked) => {
          this.compressionSettings.audio.enabled = checked;
          this.saveCompressionSettings();
          if (audioDetail) audioDetail.classList.toggle('hidden', !checked);
        },
      });
      audioSwitchMount.innerHTML = sw.render();
      sw.setupEventListeners(audioSwitchMount);
    }
    if (audioDetail) audioDetail.classList.toggle('hidden', !this.compressionSettings.audio.enabled);

    if (audioQualityMount) {
      const dropdown = new CustomDropdown({
        options: qualityOptions,
        selectedValue: this.compressionSettings.audio.quality,
        onChange: (value) => {
          this.compressionSettings.audio.quality = value as CompressionQuality;
          this.saveCompressionSettings();
        },
      });
      audioQualityMount.appendChild(dropdown.getElement());
    }

    // ---- Min size threshold
    const minSizeInput = contentContainer.querySelector('#compression-min-size-input') as HTMLInputElement | null;
    minSizeInput?.addEventListener('change', () => {
      const mb = parseInt(minSizeInput.value, 10);
      if (!Number.isFinite(mb) || mb < 1) {
        minSizeInput.value = String(Math.round(this.compressionSettings.minSizeBytes / (1024 * 1024)));
        return;
      }
      this.compressionSettings.minSizeBytes = mb * 1024 * 1024;
      this.saveCompressionSettings();
    });
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
