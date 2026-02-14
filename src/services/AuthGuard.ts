/**
 * AuthGuard Service
 * Central authentication check for all protected actions
 *
 * Usage:
 * if (!AuthGuard.requireAuth('like this note')) return;
 *
 * Shows login-required modal directly for non-logged-in users.
 */

import { AuthService } from './AuthService';
import { ModalService } from './ModalService';

export class AuthGuard {
  /**
   * Check if user is authenticated.
   * If not, show login-required modal.
   *
   * @param actionDescription - Human-readable description (e.g., "like this note", "create a post")
   * @returns true if authenticated, false if not
   */
  public static requireAuth(actionDescription: string): boolean {
    if (AuthService.getInstance().getCurrentUser()) {
      return true;
    }

    this.showLoginRequiredModal(actionDescription);
    return false;
  }

  private static showLoginRequiredModal(actionDescription: string): void {
    const modalService = ModalService.getInstance();

    const content = document.createElement('div');
    content.className = 'auth-required-modal';
    content.innerHTML = `
      <div class="auth-required-modal__icon">🔒</div>
      <h3>Login Required</h3>
      <p>Please log in to ${actionDescription}.</p>
      <div class="auth-required-modal__actions">
        <button class="btn auth-required-modal__close">OK</button>
      </div>
    `;

    content.querySelector('.auth-required-modal__close')
      ?.addEventListener('click', () => modalService.hide());

    modalService.show({
      title: 'Authentication Required',
      content,
      width: '400px',
    });
  }
}
