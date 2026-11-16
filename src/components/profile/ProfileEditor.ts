/**
 * ProfileEditor — the shared profile-metadata editor (Kind 0 events).
 *
 * ONE form, TWO hosts: the classic ProfileEditModal wraps it in the
 * ModalService dialog, the v2 focus UI mounts it as the flat
 * ProfileEditView at /profile/edit. Identical state, identical storage
 * (ProfileModuleApi.updateProfile), identical 'profile:updated' emit —
 * both UIs share one code path (docs/todos/v2-focus-ui.md: the classic
 * UI dissolves step by step, never forked).
 *
 * All queries are scoped to the mounted root element (the old modal
 * queried document-wide — a latent double-instance bug).
 */

import { ModuleLoader } from '../../core/ModuleLoader';
import type {
  ProfileModuleApi,
  ProfileMetadata,
} from '../../modules/profile/contracts';
import {
  UserProfileService,
  type UserProfile,
} from '../../services/UserProfileService';
import { AuthService } from '../../services/AuthService';
import { SystemLogger } from '../../services/SystemLogger';
import { TypedEventBus } from '../../core/TypedEventBus';
import { ImageUploader } from './ImageUploader';
import { escapeHtml } from '../../helpers/escapeHtml';
import { _ } from '../../i18n';

export class ProfileEditor {
  private _profileApi?: ProfileModuleApi | null;
  private get profileApi(): ProfileModuleApi | null {
    return (this._profileApi ??=
      ModuleLoader.getInstance().getApi<ProfileModuleApi>('profile'));
  }
  private readonly userProfileService = UserProfileService.getInstance();
  private readonly authService = AuthService.getInstance();
  private readonly systemLogger = SystemLogger.getInstance();
  private readonly eventBus = TypedEventBus.getInstance();

  private avatarUploader: ImageUploader | null = null;
  private bannerUploader: ImageUploader | null = null;

  private originalProfile: UserProfile | null = null;
  private currentProfile: Partial<ProfileMetadata> = {};
  private hasChanges = false;
  private saving = false;
  private root: HTMLElement | null = null;

  /** Load the current user's profile into the form state. */
  async load(): Promise<boolean> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.systemLogger.error(
        'ProfileEditor',
        'Cannot open: User not authenticated'
      );
      return false;
    }

    this.originalProfile = await this.userProfileService.getUserProfile(
      currentUser.pubkey
    );

    const nip05s = this.originalProfile.nip05s?.length
      ? this.originalProfile.nip05s
      : this.originalProfile.nip05
        ? [this.originalProfile.nip05]
        : [];

    this.currentProfile = {
      name: this.originalProfile.name || '',
      display_name: this.originalProfile.display_name || '',
      about: this.originalProfile.about || '',
      picture: this.originalProfile.picture || '',
      banner: this.originalProfile.banner || '',
      website: this.originalProfile.website || '',
      nip05: nip05s.join(', '),
      lud16: this.originalProfile.lud16 || '',
      lud06: this.originalProfile.lud06 || '',
    };

    this.hasChanges = false;
    this.saving = false;
    return true;
  }

  render(): string {
    this.bannerUploader = new ImageUploader({
      ...(this.currentProfile.banner && {
        currentUrl: this.currentProfile.banner,
      }),
      onUploadSuccess: url => {
        this.currentProfile.banner = url;
        this.markAsChanged();
      },
      mediaType: 'banner',
      className: 'profile-banner-uploader',
    });
    this.avatarUploader = new ImageUploader({
      ...(this.currentProfile.picture && {
        currentUrl: this.currentProfile.picture,
      }),
      onUploadSuccess: url => {
        this.currentProfile.picture = url;
        this.markAsChanged();
      },
      mediaType: 'avatar',
      className: 'profile-avatar-uploader',
    });

    return `
      <div class="profile-edit-modal">
        <div class="profile-banner-section">${this.bannerUploader.render()}</div>
        <div class="profile-avatar-section">${this.avatarUploader.render()}</div>
        ${this.renderForm()}
        <div class="profile-edit-actions">
          <button class="btn btn--passive" data-action="cancel">${_('Cancel')}</button>
          <button class="btn" data-action="save" disabled>
            <span data-save-text>${_('Sync to Relays')}</span>
            <span data-save-spinner style="display: none;">${_('Saving...')}</span>
          </button>
        </div>
      </div>
    `;
  }

  /** Bind the form to a root element (scoped queries — no document-wide). */
  bind(root: HTMLElement): void {
    this.root = root;
    const banner = root.querySelector('.profile-banner-section');
    if (banner && this.bannerUploader) {
      this.bannerUploader.setupEventListeners(banner as HTMLElement);
    }
    const avatar = root.querySelector('.profile-avatar-section');
    if (avatar && this.avatarUploader) {
      this.avatarUploader.setupEventListeners(avatar as HTMLElement);
    }

    root.querySelectorAll('[data-input]').forEach(input => {
      input.addEventListener('input', e => {
        this.handleInputChange(
          e.target as HTMLInputElement | HTMLTextAreaElement
        );
      });
    });
    root
      .querySelector('[data-action="cancel"]')
      ?.addEventListener('click', () => this.onCancel?.());
    root
      .querySelector('[data-action="save"]')
      ?.addEventListener('click', () => void this.save());
  }

  /** Unsaved form changes — the back/deferred-close guard input. */
  get dirty(): boolean {
    return this.hasChanges;
  }

  /** Optional host hooks: cancel tapped / save finished successfully. */
  onCancel?: () => void;
  onSaveSuccess?: () => void;

  private renderForm(): string {
    return `
      <form class="profile-edit-form" data-form>
        <div class="form-group">
          <label for="display_name">${_('Display Name')}</label>
          <input
            type="text"
            id="display_name"
            name="display_name"
            class="input"
            value="${escapeHtml(this.currentProfile.display_name || '')}"
            placeholder="${_('Your full name')}"
            data-input="display_name"
          />
        </div>

        <div class="form-group">
          <label for="name">${_('Username')}</label>
          <input
            type="text"
            id="name"
            name="name"
            class="input"
            value="${escapeHtml(this.currentProfile.name || '')}"
            placeholder="${_('username')}"
            data-input="name"
          />
        </div>

        <div class="form-group">
          <label for="about">${_('Bio')}</label>
          <textarea
            id="about"
            name="about"
            class="textarea textarea--small"
            rows="3"
            placeholder="${_('Tell us about yourself...')}"
            data-input="about"
          >${escapeHtml(this.currentProfile.about || '')}</textarea>
        </div>

        <div class="form-group">
          <label for="website">${_('Website')}</label>
          <input
            type="text"
            id="website"
            name="website"
            class="input"
            value="${escapeHtml(this.currentProfile.website || '')}"
            placeholder="https://example.com"
            data-input="website"
          />
        </div>

        <div class="form-group">
          <label for="nip05">${_('NIP-05 Identifier')}</label>
          <input
            type="text"
            id="nip05"
            name="nip05"
            class="input"
            value="${escapeHtml(this.currentProfile.nip05 || '')}"
            placeholder="user@domain.com"
            data-input="nip05"
          />
          <small class="form-hint">${_('Verification identifier(s), comma-separated (user@domain.com, user@other.com)')}</small>
        </div>

        <div class="form-group">
          <label for="lud16">${_('Lightning Address')}</label>
          <input
            type="text"
            id="lud16"
            name="lud16"
            class="input"
            value="${escapeHtml(this.currentProfile.lud16 || '')}"
            placeholder="user@getalby.com"
            data-input="lud16"
          />
          <small class="form-hint">${_('Email format (user@domain.com) or LNURL')}</small>
        </div>
      </form>
    `;
  }

  private handleInputChange(
    input: HTMLInputElement | HTMLTextAreaElement
  ): void {
    const fieldName = input.getAttribute('data-input');
    if (fieldName && fieldName in this.currentProfile) {
      (this.currentProfile as Record<string, string>)[fieldName] = input.value;
    }
    this.markAsChanged();
  }

  private markAsChanged(): void {
    this.hasChanges = true;
    this.updateSaveButton();
  }

  private updateSaveButton(): void {
    const saveBtn = this.root?.querySelector(
      '[data-action="save"]'
    ) as HTMLButtonElement | null;
    if (saveBtn) {
      saveBtn.disabled = !this.hasChanges || this.saving;
    }
  }

  private resetSavingState(): void {
    this.saving = false;
    this.toggleSavingState(false);
    this.updateSaveButton();
  }

  /** Publish the edited metadata; resolves true on success. */
  async save(): Promise<boolean> {
    if (!this.hasChanges || this.saving) return false;

    this.saving = true;
    this.updateSaveButton();
    this.toggleSavingState(true);

    try {
      const profileToSave = { ...this.currentProfile };
      if (profileToSave.nip05) {
        const nip05s = profileToSave.nip05
          .split(',')
          .map(s => s.trim())
          .filter(s => s.length > 0);
        profileToSave.nip05s = nip05s;
        profileToSave.nip05 = nip05s[0] || '';
      }

      const result = await (this.profileApi?.updateProfile(profileToSave) ??
        Promise.resolve(null));

      if (result) {
        const pubkey = this.authService.getCurrentUser()?.pubkey;
        if (pubkey) {
          this.eventBus.emit('profile:updated', { pubkey });
        }
        this.onSaveSuccess?.();
        return true;
      }
      this.resetSavingState();
      return false;
    } catch (error) {
      this.systemLogger.error('ProfileEditor', 'Save error:', error);
      this.resetSavingState();
      return false;
    }
  }

  private toggleSavingState(isSaving: boolean): void {
    const saveText = this.root?.querySelector(
      '[data-save-text]'
    ) as HTMLElement | null;
    const saveSpinner = this.root?.querySelector(
      '[data-save-spinner]'
    ) as HTMLElement | null;

    if (saveText) saveText.style.display = isSaving ? 'none' : 'inline';
    if (saveSpinner) saveSpinner.style.display = isSaving ? 'inline' : 'none';
  }

  destroy(): void {
    this.avatarUploader?.cleanup();
    this.bannerUploader?.cleanup();
    this.avatarUploader = null;
    this.bannerUploader = null;
    this.root = null;
  }
}
