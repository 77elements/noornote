/**
 * ProfileEditModal Component
 * Modal dialog for editing user profile metadata (Kind 0 events)
 *
 * Thin ModalService host around the SHARED ProfileEditor (the v2 focus
 * UI mounts the same editor as the flat ProfileEditView at
 * /profile/edit — one code path, two hosts). onClose covers EVERY close
 * path (save success, cancel, ESC, close button) — the editor cleans
 * itself up exactly once (destroy() is idempotent-safe here: nulled
 * uploaders make the second call a no-op).
 */

import { ModalService } from '../../services/ModalService';
import { _ } from '../../i18n';
import { ProfileEditor } from './ProfileEditor';

export class ProfileEditModal {
  private static instance: ProfileEditModal;
  private modalService: ModalService;

  private constructor() {
    this.modalService = ModalService.getInstance();
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
    const editor = new ProfileEditor();
    const loaded = await editor.load();
    if (!loaded) return;

    let closed = false;
    const closeOnce = (): void => {
      if (closed) return;
      closed = true;
      editor.destroy();
      this.modalService.hide();
    };

    this.modalService.show({
      title: _('Edit Profile'),
      content: editor.render(),
      width: '600px',
      showCloseButton: true,
      closeOnOverlay: false,
      closeOnEsc: true,
      onClose: closeOnce,
    });

    setTimeout(() => {
      const host = document.querySelector('.profile-edit-modal');
      if (!host) return;
      editor.bind(host as HTMLElement);
    }, 0);

    editor.onCancel = closeOnce;
    editor.onSaveSuccess = closeOnce;
  }
}
