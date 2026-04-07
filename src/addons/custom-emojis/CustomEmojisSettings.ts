/**
 * CustomEmojisSettings — Custom Emojis addon
 *
 * Two zones:
 *   - settings zone: enable toggle + description (mount target)
 *   - content zone:  emoji list management (queried by [data-addon-content="custom-emojis"])
 */

import { SettingsSection } from '../../components/settings/SettingsSection';
import { Switch } from '../../components/ui/Switch';
import { EventBus } from '../../services/EventBus';
import { ToastService } from '../../services/ToastService';
import { isCustomEmojisEnabled, setCustomEmojisEnabled } from './index';
import { EmojiService, type PersonalEmoji } from './EmojiService';
import { escapeHtml } from '../../helpers/escapeHtml';

export class CustomEmojisSettings extends SettingsSection {
  private enableSwitch: Switch | null = null;
  private eventBus: EventBus;
  private updatedSubId: string | null = null;
  private currentContentZone: HTMLElement | null = null;

  constructor() {
    super('custom-emojis-settings');
    this.eventBus = EventBus.getInstance();
  }

  public mount(parentContainer: HTMLElement): void {
    const contentContainer = this.getContentContainer(parentContainer);
    if (!contentContainer) return;

    const enabled = isCustomEmojisEnabled();

    this.enableSwitch = new Switch({
      label: '',
      checked: enabled,
      onChange: async (checked) => {
        setCustomEmojisEnabled(checked);
        this.eventBus.emit('custom-emojis:toggle', { enabled: checked });
        ToastService.show(checked ? 'Custom Emojis enabled' : 'Custom Emojis disabled', 'success');
        if (checked && this.currentContentZone) {
          await this.renderContentZone(this.currentContentZone);
        }
      },
    });

    contentContainer.innerHTML = `
      <div class="setting">
        <span class="setting__label">Enable Custom Emojis</span>
        <div class="setting__control">${this.enableSwitch.render()}</div>
        <p class="setting__desc">Add animated GIFs and custom images as personal emojis. Use them as reactions or in your posts via <code>:shortcode:</code>. Other Nostr clients that support NIP-30 will display them too.</p>
      </div>
    `;
    this.enableSwitch.setupEventListeners(contentContainer);

    // Mount management UI into the addon content zone (visible only when enabled)
    const contentZone = parentContainer.querySelector('[data-addon-content="custom-emojis"]') as HTMLElement | null;
    this.currentContentZone = contentZone;
    if (contentZone && enabled) {
      void this.renderContentZone(contentZone);
    }

    // Live updates whenever the pack changes
    this.updatedSubId = this.eventBus.on('emojis:updated', () => {
      if (this.currentContentZone && isCustomEmojisEnabled()) {
        this.renderEmojiList(this.currentContentZone);
      }
    });
  }

  public unmount(): void {
    if (this.enableSwitch) {
      this.enableSwitch.destroy();
      this.enableSwitch = null;
    }
    if (this.updatedSubId) {
      this.eventBus.off(this.updatedSubId);
      this.updatedSubId = null;
    }
    this.currentContentZone = null;
  }

  // ── Content zone (list + add form) ──────────────────────────────

  private async renderContentZone(zone: HTMLElement): Promise<void> {
    zone.innerHTML = `
      <h2>My Emojis</h2>
      <p class="custom-emojis__hint">Add custom emojis below. Each shortcode can be used as <code>:shortcode:</code> in posts and reactions.</p>

      <form class="custom-emojis__add-form" data-add-form>
        <div class="form__row">
          <label for="custom-emoji-shortcode">Shortcode</label>
          <input type="text" id="custom-emoji-shortcode" class="input" data-shortcode-input placeholder="celebrate" autocomplete="off" />
        </div>
        <div class="form__row">
          <label for="custom-emoji-url">Image URL</label>
          <input type="url" id="custom-emoji-url" class="input" data-url-input placeholder="https://example.com/celebrate.gif" autocomplete="off" />
        </div>
        <div class="l-row l-row--split">
          <div>
            <button type="button" class="btn btn--passive" data-upload-btn>Upload image…</button>
            <input type="file" accept="image/*" style="display:none;" data-file-input />
            <span class="custom-emojis__upload-status" data-upload-status></span>
          </div>
          <button type="submit" class="btn">Add Emoji</button>
        </div>
      </form>

      <div class="custom-emojis__list-mount"></div>
    `;

    const form = zone.querySelector('[data-add-form]') as HTMLFormElement;
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.handleAdd(zone);
    });

    const uploadBtn = zone.querySelector('[data-upload-btn]') as HTMLButtonElement | null;
    const fileInput = zone.querySelector('[data-file-input]') as HTMLInputElement | null;
    uploadBtn?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (file) await this.handleUpload(file, zone);
      fileInput.value = '';
    });

    // Initial fetch + render
    const service = EmojiService.getInstance();
    await service.refreshFromRelays();
    this.renderEmojiList(zone);
  }

  private renderEmojiList(zone: HTMLElement): void {
    const mount = zone.querySelector('.custom-emojis__list-mount') as HTMLElement | null;
    if (!mount) return;

    const emojis = EmojiService.getInstance().getEmojis();

    if (emojis.length === 0) {
      mount.innerHTML = `<p class="custom-emojis__empty">No custom emojis yet. Add your first one above.</p>`;
      return;
    }

    mount.innerHTML = `
      <div class="ui-list">
        ${emojis.map(e => this.renderRow(e)).join('')}
      </div>
    `;

    mount.querySelectorAll<HTMLButtonElement>('[data-remove-shortcode]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const code = btn.dataset.removeShortcode;
        if (!code) return;
        await this.handleRemove(code);
      });
    });
  }

  private renderRow(emoji: PersonalEmoji): string {
    const safeCode = escapeHtml(emoji.shortcode);
    const safeUrl = emoji.url.replace(/"/g, '&quot;');
    return `
      <div class="ui-list__item custom-emojis__row">
        <img class="custom-emoji" src="${safeUrl}" alt=":${safeCode}:" loading="lazy" />
        <span class="custom-emojis__code">:${safeCode}:</span>
        <button type="button" class="btn btn--passive btn--medium" data-remove-shortcode="${safeCode}">Remove</button>
      </div>
    `;
  }

  private async handleAdd(zone: HTMLElement): Promise<void> {
    const codeInput = zone.querySelector('[data-shortcode-input]') as HTMLInputElement | null;
    const urlInput = zone.querySelector('[data-url-input]') as HTMLInputElement | null;
    if (!codeInput || !urlInput) return;

    const code = codeInput.value.trim();
    const url = urlInput.value.trim();
    if (!code || !url) {
      ToastService.show('Shortcode and URL are required', 'error');
      return;
    }

    try {
      await EmojiService.getInstance().addEmoji(code, url);
      codeInput.value = '';
      urlInput.value = '';
      ToastService.show(`Added :${code}:`, 'success');
    } catch (err) {
      ToastService.show((err as Error).message, 'error');
    }
  }

  private async handleUpload(file: File, zone: HTMLElement): Promise<void> {
    const urlInput = zone.querySelector('[data-url-input]') as HTMLInputElement | null;
    const status = zone.querySelector('[data-upload-status]') as HTMLElement | null;
    if (!urlInput) return;

    if (!file.type.startsWith('image/')) {
      ToastService.show('Please select an image file', 'error');
      return;
    }

    if (status) {
      status.textContent = 'Uploading…';
      status.classList.add('pulsate');
    }

    try {
      const { MediaUploadService } = await import('../../services/MediaUploadService');
      const result = await MediaUploadService.getInstance().uploadFile(file);
      if (result.success && result.url) {
        urlInput.value = result.url;
        ToastService.show('Uploaded — give it a shortcode and click Add', 'success');
      } else {
        ToastService.show(result.error || 'Upload failed', 'error');
      }
    } catch (err) {
      ToastService.show((err as Error).message || 'Upload failed', 'error');
    } finally {
      if (status) {
        status.textContent = '';
        status.classList.remove('pulsate');
      }
    }
  }

  private async handleRemove(shortcode: string): Promise<void> {
    try {
      await EmojiService.getInstance().removeEmoji(shortcode);
      ToastService.show(`Removed :${shortcode}:`, 'success');
    } catch (err) {
      ToastService.show((err as Error).message, 'error');
    }
  }
}
