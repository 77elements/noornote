/**
 * CustomEmojisSettings — Custom Emojis addon
 *
 * Two zones:
 *   - settings zone: enable toggle + description (mount target)
 *   - content zone:  emoji list management (queried by [data-addon-content="custom-emojis"])
 */

import { SettingsSection } from '../../components/settings/SettingsSection';
import { Switch } from '../../components/ui/Switch';
import { TypedEventBus } from '../../core/TypedEventBus';
import { ToastService } from '../../services/ToastService';
import { isCustomEmojisEnabled, setCustomEmojisEnabled } from './index';
import {
  EmojiService,
  type PersonalEmoji,
  type RemoteEmojiPack,
} from './EmojiService';
import { UserSearchInput } from '../../components/user-search/UserSearchInput';
import { escapeHtml } from '../../helpers/escapeHtml';

export class CustomEmojisSettings extends SettingsSection {
  private enableSwitch: Switch | null = null;
  private eventBus: TypedEventBus;
  private updatedSubId: string | null = null;
  private currentContentZone: HTMLElement | null = null;
  private userSearchInput: UserSearchInput | null = null;

  constructor() {
    super('custom-emojis-settings');
    this.eventBus = TypedEventBus.getInstance();
  }

  public mount(parentContainer: HTMLElement): void {
    const contentContainer = this.getContentContainer(parentContainer);
    if (!contentContainer) return;

    const enabled = isCustomEmojisEnabled();

    this.enableSwitch = new Switch({
      label: '',
      checked: enabled,
      onChange: async checked => {
        setCustomEmojisEnabled(checked);
        // Emit the uniform AddonLoader event + legacy event so existing
        // listeners (CustomEmojisView etc.) keep working.
        this.eventBus.emit('custom-emojis:addon-toggle', { enabled: checked });
        ToastService.show(
          checked ? 'Custom Emojis enabled' : 'Custom Emojis disabled',
          'success'
        );
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
    const contentZone = parentContainer.querySelector(
      '[data-addon-content="custom-emojis"]'
    ) as HTMLElement | null;
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
    if (this.userSearchInput) {
      this.userSearchInput.destroy();
      this.userSearchInput = null;
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

      <section class="section">
        <h2>Import from another user</h2>
        <p class="custom-emojis__hint">Show the custom emojis of another user and import any of them into your personal pack.</p>
        <div class="custom-emojis__browse-input-mount"></div>
        <div class="custom-emojis__browse-results-mount"></div>
      </section>
    `;

    const form = zone.querySelector('[data-add-form]') as HTMLFormElement;
    form?.addEventListener('submit', async e => {
      e.preventDefault();
      await this.handleAdd(zone);
    });

    const uploadBtn = zone.querySelector(
      '[data-upload-btn]'
    ) as HTMLButtonElement | null;
    const fileInput = zone.querySelector(
      '[data-file-input]'
    ) as HTMLInputElement | null;
    uploadBtn?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (file) await this.handleUpload(file, zone);
      fileInput.value = '';
    });

    // Mount UserSearchInput for the import-from-another-user flow
    const browseInputMount = zone.querySelector(
      '.custom-emojis__browse-input-mount'
    ) as HTMLElement | null;
    if (browseInputMount) {
      this.userSearchInput?.destroy();
      this.userSearchInput = new UserSearchInput({
        placeholder: 'Show me the Custom Emojis of this user…',
        onUserSelected: pubkey => {
          void this.handleBrowseUser(pubkey, zone);
        },
        onSelectionCleared: () => {
          const resultsMount = zone.querySelector(
            '.custom-emojis__browse-results-mount'
          ) as HTMLElement | null;
          if (resultsMount) resultsMount.innerHTML = '';
        },
      });
      browseInputMount.appendChild(this.userSearchInput.getElement());
    }

    // Initial fetch + render
    const service = EmojiService.getInstance();
    await service.refreshFromRelays();
    this.renderEmojiList(zone);
  }

  private renderEmojiList(zone: HTMLElement): void {
    const mount = zone.querySelector(
      '.custom-emojis__list-mount'
    ) as HTMLElement | null;
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

    mount
      .querySelectorAll<HTMLButtonElement>('[data-remove-shortcode]')
      .forEach(btn => {
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
    const codeInput = zone.querySelector(
      '[data-shortcode-input]'
    ) as HTMLInputElement | null;
    const urlInput = zone.querySelector(
      '[data-url-input]'
    ) as HTMLInputElement | null;
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
    const urlInput = zone.querySelector(
      '[data-url-input]'
    ) as HTMLInputElement | null;
    const status = zone.querySelector(
      '[data-upload-status]'
    ) as HTMLElement | null;
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
      const { ModuleLoader } = await import('../../core/ModuleLoader');
      type MediaApi = import('../../modules/media/contracts').MediaModuleApi;
      const mediaApi =
        await ModuleLoader.getInstance().ensure<MediaApi>('media');
      if (!mediaApi) {
        ToastService.show('Media module not available', 'error');
        return;
      }
      const result = await mediaApi.uploadFile(file);
      if (result.success && result.url) {
        urlInput.value = result.url;
        ToastService.show(
          'Uploaded — give it a shortcode and click Add',
          'success'
        );
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

  // ── Browse + import from another user ───────────────────────────

  private async handleBrowseUser(
    pubkey: string,
    zone: HTMLElement
  ): Promise<void> {
    const mount = zone.querySelector(
      '.custom-emojis__browse-results-mount'
    ) as HTMLElement | null;
    if (!mount) return;

    mount.innerHTML = `<p class="custom-emojis__hint pulsate">Fetching emoji packs…</p>`;

    try {
      const packs = await EmojiService.getInstance().fetchUserPacks(pubkey);
      this.renderBrowseResults(mount, packs);
    } catch (err) {
      mount.innerHTML = `<p class="custom-emojis__empty">Failed to fetch emoji packs: ${escapeHtml((err as Error).message)}</p>`;
    }
  }

  private renderBrowseResults(
    mount: HTMLElement,
    packs: RemoteEmojiPack[]
  ): void {
    if (packs.length === 0) {
      mount.innerHTML = `<p class="custom-emojis__empty">This user has no custom emoji packs.</p>`;
      return;
    }

    mount.innerHTML = packs
      .map(
        (pack, packIdx) => `
      <div class="custom-emojis__remote-pack" data-pack-index="${packIdx}">
        <div class="l-spread">
          <h3>${escapeHtml(pack.name)} <small>(${pack.emojis.length})</small></h3>
          <button class="btn btn--passive btn--medium" data-import-all="${packIdx}">Import all</button>
        </div>
        <div class="custom-emojis__remote-grid">
          ${pack.emojis
            .map(
              (emoji, emojiIdx) => `
            <button
              type="button"
              class="custom-emojis__remote-item"
              data-import-emoji="${packIdx}:${emojiIdx}"
              title=":${escapeHtml(emoji.shortcode)}:"
            >
              <img class="custom-emoji" src="${emoji.url.replace(/"/g, '&quot;')}" alt=":${escapeHtml(emoji.shortcode)}:" loading="lazy" />
              <span class="custom-emojis__remote-code">:${escapeHtml(emoji.shortcode)}:</span>
            </button>
          `
            )
            .join('')}
        </div>
      </div>
    `
      )
      .join('');

    // Per-emoji import buttons
    mount
      .querySelectorAll<HTMLButtonElement>('[data-import-emoji]')
      .forEach(btn => {
        btn.addEventListener('click', async () => {
          const [pIdx, eIdx] = (btn.dataset.importEmoji ?? '')
            .split(':')
            .map(Number);
          const pack = packs[pIdx!];
          const emoji = pack?.emojis[eIdx!];
          if (!emoji) return;
          btn.disabled = true;
          try {
            const finalCode =
              await EmojiService.getInstance().importEmoji(emoji);
            const msg =
              finalCode === emoji.shortcode
                ? `Imported :${finalCode}:`
                : `Imported as :${finalCode}: (shortcode collision)`;
            ToastService.show(msg, 'success');
          } catch (err) {
            ToastService.show((err as Error).message, 'error');
          } finally {
            btn.disabled = false;
          }
        });
      });

    // Per-pack "Import all" buttons
    mount
      .querySelectorAll<HTMLButtonElement>('[data-import-all]')
      .forEach(btn => {
        btn.addEventListener('click', async () => {
          const pIdx = Number(btn.dataset.importAll);
          const pack = packs[pIdx];
          if (!pack) return;
          btn.disabled = true;
          btn.textContent = 'Importing…';
          try {
            const count = await EmojiService.getInstance().importPack(
              pack.emojis
            );
            ToastService.show(
              `Imported ${count} emoji${count === 1 ? '' : 's'} from "${pack.name}"`,
              'success'
            );
          } catch (err) {
            ToastService.show((err as Error).message, 'error');
          } finally {
            btn.disabled = false;
            btn.textContent = 'Import all';
          }
        });
      });
  }
}
