/**
 * AuthGuard Service
 * Central authentication check for all protected actions
 *
 * Usage:
 * if (!AuthGuard.requireAuth('like this note')) return;
 *
 * Emits 'auth:login-required' event for non-logged-in users
 * App.ts listens and shows the modal (avoids circular dependencies)
 */

import { AuthService } from './AuthService';
import { EventBus } from './EventBus';

export class AuthGuard {
  /**
   * Check if user is authenticated
   * If not, emit event for login modal
   *
   * @param actionDescription - Human-readable description (e.g., "like this note", "create a post")
   * @returns true if authenticated, false if not
   */
  public static requireAuth(actionDescription: string): boolean {
    const currentUser = AuthService.getInstance().getCurrentUser();

    if (currentUser) {
      return true;
    }

    // Emit event - App.ts will show the modal
    EventBus.getInstance().emit('auth:login-required', { action: actionDescription });
    return false;
  }
}
