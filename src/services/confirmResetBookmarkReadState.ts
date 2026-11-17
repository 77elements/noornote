/**
 * "Reset read state" confirm flow, shared by the bookmarks addon settings
 * and the bookmarks panel in the v2 focus settings: one destructive
 * confirm, then BookmarkReadStateService.reset() with success/failure toasts.
 */

import { ModalService } from './ModalService';
import { ToastService } from './ToastService';
import { BookmarkReadStateService } from './BookmarkReadStateService';
import { _ } from '../i18n';

export function confirmResetBookmarkReadState(): void {
  void ModalService.getInstance()
    .confirm({
      title: _('Reset read state'),
      message: _(
        'Mark ALL bookmarks as unread again? Your other devices will pick this up on their next sync.'
      ),
      confirmText: _('Reset'),
      confirmDestructive: true,
    })
    .then(confirmed => {
      if (!confirmed) return;
      BookmarkReadStateService.getInstance()
        .reset()
        .then(() =>
          ToastService.show(
            _('Read state reset, all bookmarks unread'),
            'success'
          )
        )
        .catch(error =>
          ToastService.show(_('Reset failed: %s', String(error)), 'error', 8000)
        );
    });
}
