/**
 * ProfileEditView Component
 * Full-page profile editor at /profile/edit — the flat replacement for
 * the classic ProfileEditModal in the v2 Focus UI (the composer pattern:
 * same form as the modal, one SHARED ProfileEditor code path, opened via
 * the profile object's gear or its Edit button). On save success /
 * cancel the view reports back via the onClose callback (wired by the
 * focus surface to "return to the profile").
 */

import { View } from './View';
import { _ } from '../../i18n';
import { ModalService } from '../../services/ModalService';
import { ProfileEditor } from '../profile/ProfileEditor';

export interface ProfileEditViewOptions {
  /** Called after a successful save or a confirmed close — returns to the profile. */
  onClose?: () => void;
}

export class ProfileEditView extends View {
  private container: HTMLElement;
  private readonly onClose: () => void;
  private readonly editor = new ProfileEditor();
  /** Set when the view is closing unconditionally so confirmBack no
   *  longer vetoes the back. */
  private closing = false;

  constructor(options?: ProfileEditViewOptions) {
    super();
    this.onClose = options?.onClose ?? (() => {});
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--profile-edit';

    void this.init();

    // Host hooks. Cancel = instant close (classic-modal parity, no
    // confirm); save success closes after the publish resolves.
    this.editor.onCancel = () => this.close();
    this.editor.onSaveSuccess = () => this.close();
  }

  getElement(): HTMLElement {
    return this.container;
  }

  private async init(): Promise<void> {
    const loaded = await this.editor.load();
    if (!loaded) {
      // Not authenticated (direct URL) — leave immediately.
      this.closing = true;
      this.onClose();
      return;
    }
    // The editor's root keeps the .profile-edit-modal wrapper class —
    // the form styles are keyed on it (CSS reuse across both hosts).
    this.container.innerHTML = this.editor.render();
    // Bind on the next tick: the element mounts into the column after
    // the constructor returns (same deferred setup as the modal).
    setTimeout(() => {
      if (this.closing) return;
      this.editor.bind(this.container);
    }, 0);
  }

  /**
   * Back-veto for the focus surface: a dirty editor asks "Discard
   * changes?" first (mirrors the composer's unsaved-content guard).
   */
  confirmBack(): boolean {
    if (this.closing || !this.editor.dirty) return true;
    queueMicrotask(() => void this.askDiscardThenClose());
    return false;
  }

  private async askDiscardThenClose(): Promise<void> {
    const discard = await ModalService.getInstance().confirm({
      title: _('Discard changes?'),
      message: _('You have unsaved profile changes. Discard them?'),
      confirmText: _('Discard'),
      cancelText: _('Keep editing'),
      confirmDestructive: true,
    });
    if (!discard) return;
    // The confirm dialog parked a same-URL history marker (OverlayStack);
    // its cleanup history.back() lands async — wait for that popstate
    // (timeout fallback) before closing, or it would restore the edit
    // URL after our back-navigation rewrote it.
    const proceed = (): void => {
      window.removeEventListener('popstate', onPop);
      if (this.closing) return;
      this.close();
    };
    const onPop = (): void => proceed();
    window.addEventListener('popstate', onPop, { once: true });
    setTimeout(proceed, 300);
  }

  /** Unconditional close (cancel / discard / save success). */
  private close(): void {
    if (this.closing) return;
    this.closing = true;
    this.editor.destroy();
    this.onClose();
  }

  destroy(): void {
    this.editor.destroy();
  }
}
