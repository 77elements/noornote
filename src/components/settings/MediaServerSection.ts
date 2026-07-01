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
    { url: 'https://nostr.build', name: 'nostr.build (Most popular, NIP-96, free: 20 MiB)', protocol: 'nip96' as const, maxFileSize: 20 * 1024 * 1024 },
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
      image: { ...DEFAULT_MEDIA_COMPRESSION_SETTINGS.image, ...stored.image },
      video: { ...DEFAULT_MEDIA_COMPRESSION_SETTINGS.video, ...stored.video },
      audio: { ...DEFAULT_MEDIA_COMPRESSION_SETTINGS.audio, ...stored.audio },
    };
  }

  private saveCompressionSettings(): void {
    PerAccountLocalStorage.getInstance().set(StorageKeys.MEDIA_COMPRESSION, this.compressionSettings);
  }

  /**
   * Load media server settings from storage
   */
  private loadMediaServerSettings(): MediaServerSettings {
    const stored = PerAccountLocalStorage.getInstance().get<MediaServerSettings>(
      StorageKeys.MEDIA_SERVER,
      { url: 'https://nostr.build', protocol: 'nip96' }
    );
    // Presets are the source of truth for their free-tier size limits. Re-derive
    // maxFileSize from the matching preset so accounts that stored an outdated
    // value (or none) pick up corrected limits without re-selecting the server.
    // Persist the correction so the upload service (which reads the same storage
    // key) enforces the right limit on its pre-upload size check.
    const preset = MediaServerSection.POPULAR_SERVERS.find(s => s.url === stored.url);
    if (preset && stored.maxFileSize !== preset.maxFileSize) {
      stored.maxFileSize = preset.maxFileSize;
      PerAccountLocalStorage.getInstance().set(StorageKeys.MEDIA_SERVER, stored);
    }
    return stored;
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
          ${this.renderImageCompression()}
        </section>

        <section class="section">
          ${this.renderVideoCompression()}
        </section>

        <section class="section">
          ${this.renderAudioCompression()}
        </section>

        <section class="section">
          ${this.renderExifStripCritical()}
        </section>

        <section class="section">
          ${this.renderExifStripMedium()}
        </section>

        <section class="section">
          ${this.renderExifStripWeak()}
        </section>

        <section class="section">
          ${this.renderSensitiveMedia()}
        </section>
    `;
  }

  private renderExifStripCritical(): string {
    return `
        <div class="setting">
          <span class="setting__label">Strip location & identity (EXIF)</span>
          <div class="setting__control" id="strip-exif-critical-mount"></div>
          <p class="setting__desc">
            When uploading JPEG images, removes: GPS coordinates, GPS altitude, GPS timestamp,
            GPS direction, GPS destination; Artist, Copyright, OwnerName, CameraOwnerName,
            BodySerialNumber, LensSerialNumber, ImageUniqueID; Windows XP tags
            (Title, Author, Comment, Keywords, Subject).
          </p>
        </div>
    `;
  }

  private renderExifStripMedium(): string {
    return `
        <div class="setting">
          <span class="setting__label">Strip timestamps & maker blob (EXIF)</span>
          <div class="setting__control" id="strip-exif-medium-mount"></div>
          <p class="setting__desc">
            When uploading JPEG images, removes: DateTime, DateTimeOriginal, DateTimeDigitized,
            OffsetTime / OffsetTimeOriginal / OffsetTimeDigitized (timezone),
            SubSecTime / SubSecTimeOriginal / SubSecTimeDigitized; MakerNote
            (vendor-specific binary blob, may contain serials or internal IDs).
          </p>
        </div>
    `;
  }

  private renderExifStripWeak(): string {
    return `
        <div class="setting">
          <span class="setting__label">Strip device info (EXIF)</span>
          <div class="setting__control" id="strip-exif-weak-mount"></div>
          <p class="setting__desc">
            When uploading JPEG images, removes: Make, Model, LensMake, LensModel,
            Software, HostComputer.
          </p>
        </div>
    `;
  }

  private renderImageCompression(): string {
    const minKb = Math.round(this.compressionSettings.image.minSizeBytes / 1024);
    return `
        <div class="setting">
          <span class="setting__label">Image Compression</span>
          <div class="setting__control" id="compress-image-switch-mount"></div>
          <p class="setting__desc">
            Images are resized and re-encoded as JPEG locally before upload, reducing file size and
            saving CDN bandwidth. EXIF metadata is preserved verbatim — no privacy fields are
            stripped at this layer.
          </p>
        </div>

        <div class="setting" id="compress-image-quality-row">
          <span class="setting__label">Quality</span>
          <div class="setting__control" id="compress-image-quality-mount"></div>
        </div>

        <div class="setting" id="compress-image-resolution-row">
          <span class="setting__label">Max resolution</span>
          <div class="setting__control" id="compress-image-resolution-mount"></div>
        </div>

        <div class="form__row form__row--oneline" id="compress-image-min-size-row">
          <label for="compression-image-min-size-input">Skip compression for files below</label>
          <input
            type="text"
            class="input"
            id="compression-image-min-size-input"
            value="${minKb}"
          /> KB
        </div>
    `;
  }

  private renderVideoCompression(): string {
    const minMb = Math.round(this.compressionSettings.video.minSizeBytes / (1024 * 1024));
    return `
        <div class="setting">
          <span class="setting__label">Video Compression</span>
          <div class="setting__control" id="compress-video-switch-mount"></div>
          <p class="setting__desc">
            Videos are compressed locally using your device's hardware encoder (WebCodecs) before
            upload — your video never leaves your device until upload.
          </p>
        </div>

        <div class="setting" id="compress-video-quality-row">
          <span class="setting__label">Quality</span>
          <div class="setting__control" id="compress-video-quality-mount"></div>
        </div>

        <div class="setting" id="compress-video-resolution-row">
          <span class="setting__label">Max resolution</span>
          <div class="setting__control" id="compress-video-resolution-mount"></div>
        </div>

        <div class="form__row form__row--oneline" id="compress-video-min-size-row">
          <label for="compression-video-min-size-input">Skip compression for files below</label>
          <input
            type="text"
            class="input"
            id="compression-video-min-size-input"
            value="${minMb}"
          /> MB
        </div>
    `;
  }

  private renderAudioCompression(): string {
    const minMb = Math.round(this.compressionSettings.audio.minSizeBytes / (1024 * 1024));
    return `
        <div class="setting">
          <span class="setting__label">Audio Compression</span>
          <div class="setting__control" id="compress-audio-switch-mount"></div>
          <p class="setting__desc">
            Audio files are compressed locally before upload using a hardware-supported codec.
          </p>
        </div>

        <div class="setting" id="compress-audio-quality-row">
          <span class="setting__label">Quality</span>
          <div class="setting__control" id="compress-audio-quality-mount"></div>
        </div>

        <div class="form__row form__row--oneline" id="compress-audio-min-size-row">
          <label for="compression-audio-min-size-input">Skip compression for files below</label>
          <input
            type="text"
            class="input"
            id="compression-audio-min-size-input"
            value="${minMb}"
          /> MB
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
    const imageResolutionOptions = [
      { value: '720', label: '720 px' },
      { value: '1024', label: '1024 px' },
      { value: '1280', label: '1280 px' },
      { value: '0', label: 'Original' },
    ];

    // ---- Video toggle + detail rows
    const videoSwitchMount = contentContainer.querySelector('#compress-video-switch-mount') as HTMLElement | null;
    const videoDetailRows = [
      contentContainer.querySelector('#compress-video-quality-row') as HTMLElement | null,
      contentContainer.querySelector('#compress-video-resolution-row') as HTMLElement | null,
      contentContainer.querySelector('#compress-video-min-size-row') as HTMLElement | null,
    ];
    const setVideoDetailVisible = (show: boolean) => {
      videoDetailRows.forEach(row => row?.classList.toggle('hidden', !show));
    };
    const videoQualityMount = contentContainer.querySelector('#compress-video-quality-mount') as HTMLElement | null;
    const videoResolutionMount = contentContainer.querySelector('#compress-video-resolution-mount') as HTMLElement | null;

    if (videoSwitchMount) {
      const sw = new Switch({
        label: '',
        checked: this.compressionSettings.video.enabled,
        onChange: (checked) => {
          this.compressionSettings.video.enabled = checked;
          this.saveCompressionSettings();
          setVideoDetailVisible(checked);
          ToastService.show(checked ? 'Video compression enabled' : 'Video compression disabled', 'success');
        },
      });
      videoSwitchMount.innerHTML = sw.render();
      sw.setupEventListeners(videoSwitchMount);
    }
    setVideoDetailVisible(this.compressionSettings.video.enabled);

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

    // ---- Audio toggle + detail rows
    const audioSwitchMount = contentContainer.querySelector('#compress-audio-switch-mount') as HTMLElement | null;
    const audioDetailRows = [
      contentContainer.querySelector('#compress-audio-quality-row') as HTMLElement | null,
      contentContainer.querySelector('#compress-audio-min-size-row') as HTMLElement | null,
    ];
    const setAudioDetailVisible = (show: boolean) => {
      audioDetailRows.forEach(row => row?.classList.toggle('hidden', !show));
    };
    const audioQualityMount = contentContainer.querySelector('#compress-audio-quality-mount') as HTMLElement | null;

    if (audioSwitchMount) {
      const sw = new Switch({
        label: '',
        checked: this.compressionSettings.audio.enabled,
        onChange: (checked) => {
          this.compressionSettings.audio.enabled = checked;
          this.saveCompressionSettings();
          setAudioDetailVisible(checked);
          ToastService.show(checked ? 'Audio compression enabled' : 'Audio compression disabled', 'success');
        },
      });
      audioSwitchMount.innerHTML = sw.render();
      sw.setupEventListeners(audioSwitchMount);
    }
    setAudioDetailVisible(this.compressionSettings.audio.enabled);

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

    // ---- Image toggle + detail rows
    const imageSwitchMount = contentContainer.querySelector('#compress-image-switch-mount') as HTMLElement | null;
    const imageDetailRows = [
      contentContainer.querySelector('#compress-image-quality-row') as HTMLElement | null,
      contentContainer.querySelector('#compress-image-resolution-row') as HTMLElement | null,
      contentContainer.querySelector('#compress-image-min-size-row') as HTMLElement | null,
    ];
    const setImageDetailVisible = (show: boolean) => {
      imageDetailRows.forEach(row => row?.classList.toggle('hidden', !show));
    };
    const imageQualityMount = contentContainer.querySelector('#compress-image-quality-mount') as HTMLElement | null;
    const imageResolutionMount = contentContainer.querySelector('#compress-image-resolution-mount') as HTMLElement | null;

    if (imageSwitchMount) {
      const sw = new Switch({
        label: '',
        checked: this.compressionSettings.image.enabled,
        onChange: (checked) => {
          this.compressionSettings.image.enabled = checked;
          this.saveCompressionSettings();
          setImageDetailVisible(checked);
          ToastService.show(checked ? 'Image compression enabled' : 'Image compression disabled', 'success');
        },
      });
      imageSwitchMount.innerHTML = sw.render();
      sw.setupEventListeners(imageSwitchMount);
    }
    setImageDetailVisible(this.compressionSettings.image.enabled);

    if (imageQualityMount) {
      const dropdown = new CustomDropdown({
        options: qualityOptions,
        selectedValue: this.compressionSettings.image.quality,
        onChange: (value) => {
          this.compressionSettings.image.quality = value as CompressionQuality;
          this.saveCompressionSettings();
        },
      });
      imageQualityMount.appendChild(dropdown.getElement());
    }
    if (imageResolutionMount) {
      const dropdown = new CustomDropdown({
        options: imageResolutionOptions,
        selectedValue: String(this.compressionSettings.image.maxResolution),
        onChange: (value) => {
          this.compressionSettings.image.maxResolution = Number(value) as MaxResolution;
          this.saveCompressionSettings();
        },
      });
      imageResolutionMount.appendChild(dropdown.getElement());
    }

    // ---- Per-kind min-size thresholds
    const imageMinInput = contentContainer.querySelector('#compression-image-min-size-input') as HTMLInputElement | null;
    imageMinInput?.addEventListener('change', () => {
      const kb = parseInt(imageMinInput.value, 10);
      if (!Number.isFinite(kb) || kb < 1) {
        imageMinInput.value = String(Math.round(this.compressionSettings.image.minSizeBytes / 1024));
        return;
      }
      this.compressionSettings.image.minSizeBytes = kb * 1024;
      this.saveCompressionSettings();
    });

    const videoMinInput = contentContainer.querySelector('#compression-video-min-size-input') as HTMLInputElement | null;
    videoMinInput?.addEventListener('change', () => {
      const mb = parseInt(videoMinInput.value, 10);
      if (!Number.isFinite(mb) || mb < 1) {
        videoMinInput.value = String(Math.round(this.compressionSettings.video.minSizeBytes / (1024 * 1024)));
        return;
      }
      this.compressionSettings.video.minSizeBytes = mb * 1024 * 1024;
      this.saveCompressionSettings();
    });

    const audioMinInput = contentContainer.querySelector('#compression-audio-min-size-input') as HTMLInputElement | null;
    audioMinInput?.addEventListener('change', () => {
      const mb = parseInt(audioMinInput.value, 10);
      if (!Number.isFinite(mb) || mb < 1) {
        audioMinInput.value = String(Math.round(this.compressionSettings.audio.minSizeBytes / (1024 * 1024)));
        return;
      }
      this.compressionSettings.audio.minSizeBytes = mb * 1024 * 1024;
      this.saveCompressionSettings();
    });

    // ---- EXIF stripping switches (privacy)
    const stripCriticalMount = contentContainer.querySelector('#strip-exif-critical-mount') as HTMLElement | null;
    if (stripCriticalMount) {
      const sw = new Switch({
        label: '',
        checked: this.compressionSettings.image.stripExifCritical,
        onChange: (checked) => {
          this.compressionSettings.image.stripExifCritical = checked;
          this.saveCompressionSettings();
          ToastService.show(`Location & identity stripping ${checked ? 'enabled' : 'disabled'}`, 'success');
        },
      });
      stripCriticalMount.innerHTML = sw.render();
      sw.setupEventListeners(stripCriticalMount);
    }

    const stripMediumMount = contentContainer.querySelector('#strip-exif-medium-mount') as HTMLElement | null;
    if (stripMediumMount) {
      const sw = new Switch({
        label: '',
        checked: this.compressionSettings.image.stripExifMedium,
        onChange: (checked) => {
          this.compressionSettings.image.stripExifMedium = checked;
          this.saveCompressionSettings();
          ToastService.show(`Timestamps & maker blob stripping ${checked ? 'enabled' : 'disabled'}`, 'success');
        },
      });
      stripMediumMount.innerHTML = sw.render();
      sw.setupEventListeners(stripMediumMount);
    }

    const stripWeakMount = contentContainer.querySelector('#strip-exif-weak-mount') as HTMLElement | null;
    if (stripWeakMount) {
      const sw = new Switch({
        label: '',
        checked: this.compressionSettings.image.stripExifWeak,
        onChange: (checked) => {
          this.compressionSettings.image.stripExifWeak = checked;
          this.saveCompressionSettings();
          ToastService.show(`Device info stripping ${checked ? 'enabled' : 'disabled'}`, 'success');
        },
      });
      stripWeakMount.innerHTML = sw.render();
      sw.setupEventListeners(stripWeakMount);
    }
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
