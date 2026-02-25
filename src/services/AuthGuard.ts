/**
 * AuthGuard Service
 * Central authentication check for all protected actions
 *
 * Usage:
 * if (!AuthGuard.requireAuth('like this note')) return;
 *
 * Shows humorous logged-out modal with CTA buttons for non-logged-in users.
 */

import { AuthService } from './AuthService';
import { showLoggedOutReactionModal } from '../helpers/LoggedOutModals';

/** Map action description keywords to reaction types for humorous modals */
const ACTION_TO_REACTION: Record<string, string> = {
  'like': 'like',
  'react': 'like',
  'zap': 'zap',
  'repost': 'repost',
  'quote': 'repost',
  'reply': 'reply',
  'bookmark': 'bookmark',
};

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
    // Detect reaction type from the action description
    const lowerDesc = actionDescription.toLowerCase();
    let reactionType = 'like'; // default

    for (const [keyword, type] of Object.entries(ACTION_TO_REACTION)) {
      if (lowerDesc.includes(keyword)) {
        reactionType = type;
        break;
      }
    }

    showLoggedOutReactionModal(reactionType);
  }
}
