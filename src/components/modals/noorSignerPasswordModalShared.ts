/**
 * Shared submit/cancel/keyboard wiring for the NoorSigner password modals
 * (KeySigner account switch ↔ NoorSigner daemon unlock): identical
 * busy-state, password validation, error display and keyboard mechanics
 * around a modal-specific `submit` callback.
 */

import { errMessage } from '../../helpers/errorMessage';
import { _ } from '../../i18n';

export function wireNoorSignerPasswordModal(opts: {
  input: HTMLInputElement;
  cancelBtn: Element;
  submitBtn: HTMLElement;
  errorEl: HTMLElement;
  /** Button label while the request runs (e.g. "Unlocking..."). */
  busyLabel: string;
  /** Button label after the request settles. */
  idleLabel: string;
  /** Perform the modal-specific work; throws on failure. */
  submit: () => Promise<void>;
  /** True when a failure message means "wrong password". */
  isPasswordError: (message: string) => boolean;
  /** Extra cleanup after a failed attempt (e.g. re-prepare the daemon). */
  onPasswordError?: () => void;
  /** Hide the modal (ModalService.hide). */
  hide: () => void;
  /** Called after a successful submit (modal already hidden). */
  onSuccess: () => void;
  /** Called when the user cancels (modal already hidden). */
  onCancel?: () => void;
  /** Show an error inside the modal (existing per-modal impl). */
  showError: (message: string) => void;
}): void {
  let isSubmitting = false;

  const handleSubmit = async () => {
    if (isSubmitting) return;

    const password = opts.input.value;
    if (!password) {
      opts.showError(_('Please enter your password'));
      return;
    }

    isSubmitting = true;
    opts.submitBtn.textContent = _(opts.busyLabel);
    opts.submitBtn.setAttribute('disabled', 'true');
    opts.errorEl.style.display = 'none';

    try {
      await opts.submit();
      opts.hide();
      opts.onSuccess();
    } catch (error) {
      const errorMessage = errMessage(error);
      opts.showError(
        opts.isPasswordError(errorMessage)
          ? _('Incorrect password')
          : errorMessage
      );
      opts.onPasswordError?.();
      opts.input.value = '';
      opts.input.focus();
    } finally {
      isSubmitting = false;
      opts.submitBtn.textContent = _(opts.idleLabel);
      opts.submitBtn.removeAttribute('disabled');
    }
  };

  const handleCancel = () => {
    opts.hide();
    opts.onCancel?.();
  };

  opts.cancelBtn.addEventListener('click', handleCancel);
  opts.submitBtn.addEventListener('click', () => void handleSubmit());

  opts.input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      void handleSubmit();
    } else if (e.key === 'Escape') {
      handleCancel();
    }
  });

  // Clear error when typing
  opts.input.addEventListener('input', () => {
    opts.errorEl.style.display = 'none';
  });
}
