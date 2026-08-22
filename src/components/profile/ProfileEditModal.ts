/**
 * ProfileEditModal Component
 * Modal dialog for editing user profile metadata (Kind 0 events)
 *
 * Features:
 * - Avatar and banner image upload (uses ImageUploader)
 * - Text inputs for all profile fields
 * - Validation (NIP-05, Lightning address, URLs)
 * - Live preview of uploaded images
 * - Save button (publishes to relays via ProfileEditorService)
 */

import { ModalService } from '../../services/ModalService';
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
import { ImageUploader } from './ImageUploader';
import { TypedEventBus } from '../../core/TypedEventBus';
import { escapeHtml } from '../../helpers/escapeHtml';

export class ProfileEditModal {
  private static instance: ProfileEditModal;
  private modalService: ModalService;
  private _profileApi?: ProfileModuleApi | null;
  private get profileApi(): ProfileModuleApi | null {
    return (this._profileApi ??=
      ModuleLoader.getInstance().getApi<ProfileModuleApi>('profile'));
  }
  private userProfileService: UserProfileService;
  private authService: AuthService;
  private systemLogger: SystemLogger;
  private eventBus: TypedEventBus;

  // Sub-components
  private avatarUploader: ImageUploader | null = null;
  private bannerUploader: ImageUploader | null = null;

  // State
  private originalProfile: UserProfile | null = null;
  private currentProfile: Partial<ProfileMetadata> = {};
  private hasChanges: boolean = false;
  private saving: boolean = false;

  private constructor() {
    this.modalService = ModalService.getInstance();
    this.userProfileService = UserProfileService.getInstance();
    this.authService = AuthService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.eventBus = TypedEventBus.getInstance();
  }

  public static getInstance(): ProfileEditModal {
    if (!ProfileEditModal.instance) {
      ProfileEditModal.instance = new ProfileEditModal();
    }
    return ProfileEditModal.instance;
  }

  /**
   * Show the profile editor modal
   */
  public async show(): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.systemLogger.error(
        'ProfileEditModal',
        'Cannot open: User not authenticated'
      );
      return;
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

    this.modalService.show({
      title: 'Edit Profile',
      content: this.renderContent(),
      width: '600px',
      showCloseButton: true,
      closeOnOverlay: false,
      closeOnEsc: true,
    });

    setTimeout(() => this.setupEventHandlers(), 0);
  }

  private renderContent(): string {
    return `
      <div class="profile-edit-modal">
        ${this.renderBannerUploader()}
        ${this.renderAvatarUploader()}
        ${this.renderForm()}
        ${this.renderActions()}
      </div>
    `;
  }

  private renderBannerUploader(): string {
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

    return `
      <div class="profile-banner-section">
        ${this.bannerUploader.render()}
      </div>
    `;
  }

  private renderAvatarUploader(): string {
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
      <div class="profile-avatar-section">
        ${this.avatarUploader.render()}
      </div>
    `;
  }

  private renderForm(): string {
    return `
      <form class="profile-edit-form" data-form>
        <div class="form-group">
          <label for="display_name">Display Name</label>
          <input
            type="text"
            id="display_name"
            name="display_name"
            class="input"
            value="${escapeHtml(this.currentProfile.display_name || '')}"
            placeholder="Your full name"
            data-input="display_name"
          />
        </div>

        <div class="form-group">
          <label for="name">Username</label>
          <input
            type="text"
            id="name"
            name="name"
            class="input"
            value="${escapeHtml(this.currentProfile.name || '')}"
            placeholder="username"
            data-input="name"
          />
        </div>

        <div class="form-group">
          <label for="about">Bio</label>
          <textarea
            id="about"
            name="about"
            class="textarea textarea--small"
            rows="3"
            placeholder="Tell us about yourself..."
            data-input="about"
          >${escapeHtml(this.currentProfile.about || '')}</textarea>
        </div>

        <div class="form-group">
          <label for="website">Website</label>
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
          <label for="nip05">NIP-05 Identifier</label>
          <input
            type="text"
            id="nip05"
            name="nip05"
            class="input"
            value="${escapeHtml(this.currentProfile.nip05 || '')}"
            placeholder="user@domain.com"
            data-input="nip05"
          />
          <small class="form-hint">Verification identifier(s), comma-separated (user@domain.com, user@other.com)</small>
        </div>

        <div class="form-group">
          <label for="lud16">Lightning Address</label>
          <input
            type="text"
            id="lud16"
            name="lud16"
            class="input"
            value="${escapeHtml(this.currentProfile.lud16 || '')}"
            placeholder="user@getalby.com"
            data-input="lud16"
          />
          <small class="form-hint">Email format (user@domain.com) or LNURL</small>
        </div>
      </form>
    `;
  }

  private renderActions(): string {
    return `
      <div class="profile-edit-actions">
        <button class="btn btn--passive" data-action="cancel">Cancel</button>
        <button class="btn" data-action="save" disabled>
          <span data-save-text>Sync to Relays</span>
          <span data-save-spinner style="display: none;">Saving...</span>
        </button>
      </div>
    `;
  }

  private setupImageUploader(
    modal: Element,
    sectionClass: string,
    uploader: ImageUploader | null
  ): void {
    const section = modal.querySelector(`.${sectionClass}`);
    if (section && uploader) {
      uploader.setupEventListeners(section as HTMLElement);
    }
  }

  private setupEventHandlers(): void {
    const modal = document.querySelector('.profile-edit-modal');
    if (!modal) return;

    this.setupImageUploader(
      modal,
      'profile-banner-section',
      this.bannerUploader
    );
    this.setupImageUploader(
      modal,
      'profile-avatar-section',
      this.avatarUploader
    );

    modal.querySelectorAll('[data-input]').forEach(input => {
      input.addEventListener('input', e => {
        this.handleInputChange(
          e.target as HTMLInputElement | HTMLTextAreaElement
        );
      });
    });

    modal
      .querySelector('[data-action="cancel"]')
      ?.addEventListener('click', () => this.handleCancel());
    modal
      .querySelector('[data-action="save"]')
      ?.addEventListener('click', () => this.handleSave());
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
    const saveBtn = document.querySelector(
      '[data-action="save"]'
    ) as HTMLButtonElement;
    if (saveBtn) {
      saveBtn.disabled = !this.hasChanges || this.saving;
    }
  }

  private handleCancel(): void {
    this.cleanup();
    this.modalService.hide();
  }

  private resetSavingState(): void {
    this.saving = false;
    this.toggleSavingState(false);
    this.updateSaveButton();
  }

  private async handleSave(): Promise<void> {
    if (!this.hasChanges || this.saving) return;

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
        this.cleanup();
        this.modalService.hide();
      } else {
        this.resetSavingState();
      }
    } catch (error) {
      this.systemLogger.error('ProfileEditModal', 'Save error:', error);
      this.resetSavingState();
    }
  }

  private toggleSavingState(isSaving: boolean): void {
    const saveText = document.querySelector('[data-save-text]') as HTMLElement;
    const saveSpinner = document.querySelector(
      '[data-save-spinner]'
    ) as HTMLElement;

    if (saveText) saveText.style.display = isSaving ? 'none' : 'inline';
    if (saveSpinner) saveSpinner.style.display = isSaving ? 'inline' : 'none';
  }

  private cleanup(): void {
    this.avatarUploader?.cleanup();
    this.bannerUploader?.cleanup();
    this.avatarUploader = null;
    this.bannerUploader = null;
  }
}
