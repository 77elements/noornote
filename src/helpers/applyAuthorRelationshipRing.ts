/**
 * applyAuthorRelationshipRing
 *
 * Flags an avatar element with a relationship ring toward the current user:
 *   - red  (author-rel--muted)   → `pubkey` has PUBLICLY muted the current user
 *   - green (author-rel--follows) → `pubkey` follows the current user
 *
 * Muted wins over follows. Async + cached (RemoteMuteCheck / FollowVerification);
 * best-effort, so a failed lookup simply leaves the avatar unringed. No-op for the
 * current user's own avatar or when logged out. The actual border is styled in CSS
 * (see _note-ui.scss) — this only toggles the class.
 *
 * Used by the reply-thread render path (ThreadManager for the reply author avatar,
 * ThreadContextIndicator for the ↳ parent avatars) so a user can tell at a glance
 * who in a thread follows them or has muted them (and thus won't see a reply).
 */

import { AuthService } from '../services/AuthService';
import { FollowVerificationService } from '../services/FollowVerificationService';
import { RemoteMuteCheckService } from '../services/RemoteMuteCheckService';

export function applyAuthorRelationshipRing(
  avatar: Element | null | undefined,
  pubkey: string
): void {
  if (!avatar) return;

  const currentUser = AuthService.getInstance().getCurrentUser();
  if (!currentUser || currentUser.pubkey === pubkey) return;

  Promise.all([
    RemoteMuteCheckService.getInstance().mutedByThemSimple(pubkey),
    FollowVerificationService.getInstance().followsBackSimple(pubkey),
  ])
    .then(([muted, follows]) => {
      if (muted) avatar.classList.add('author-rel--muted');
      else if (follows) avatar.classList.add('author-rel--follows');
    })
    .catch(() => {
      /* best-effort ring; ignore lookup failures */
    });
}
