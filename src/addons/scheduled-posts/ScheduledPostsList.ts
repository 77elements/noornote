/**
 * ScheduledPostsList — the "Your scheduled posts" list, shared by both
 * consumers of the Scheduled Posts addon:
 *   - ScheduledPostsAddonView (classic /addons/scheduled-posts page)
 *   - the ED-b object-settings panel while the v2 composer is open
 *
 * Owns loading, rendering, and cancelling; refreshes itself on
 * 'scheduled-posts:changed' (emitted after a schedule/cancel anywhere).
 * mount() may be called again to re-render from scratch; destroy() drops
 * every listener and reference (addon destroy contract).
 */

import { TypedEventBus } from '../../core/TypedEventBus';
import { ModalService } from '../../services/ModalService';
import { AuthService } from '../../services/AuthService';
import { SystemLogger } from '../../services/SystemLogger';
import { ToastService } from '../../services/ToastService';
import { escapeHtml } from '../../helpers/escapeHtml';
import { _ } from '../../i18n';
import {
  ScheduledPostService,
  type ScheduledPost,
} from './ScheduledPostService';

export class ScheduledPostsList {
  private host: HTMLElement | null = null;
  private posts: ScheduledPost[] = [];
  private loading = false;
  private changedSubId: string | null = null;

  mount(host: HTMLElement): void {
    this.host = host;
    this.changedSubId = TypedEventBus.getInstance().on(
      'scheduled-posts:changed',
      () => {
        void this.loadAndRender();
      }
    );
    void this.loadAndRender();
  }

  destroy(): void {
    if (this.changedSubId) {
      TypedEventBus.getInstance().off(this.changedSubId);
      this.changedSubId = null;
    }
    this.host = null;
    this.posts = [];
    this.loading = false;
  }

  private async loadAndRender(): Promise<void> {
    if (!this.host) return;
    const user = AuthService.getInstance().getCurrentUser();
    if (!user) {
      this.posts = [];
      this.render();
      return;
    }
    this.loading = true;
    this.render();
    try {
      this.posts = await ScheduledPostService.getInstance().getScheduled(
        user.pubkey
      );
      this.posts.sort((a, b) => a.publishAt - b.publishAt);
    } catch (err) {
      SystemLogger.getInstance().warn(
        'ScheduledPostsList',
        `Failed to load list: ${String(err)}`
      );
      this.posts = [];
      ToastService.show(_('Failed to load scheduled posts'), 'error');
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private render(): void {
    if (!this.host) return;

    if (this.loading) {
      this.host.innerHTML = `<div class="scheduled-post__empty pulsate">${_('Loading scheduled posts...')}</div>`;
      return;
    }

    if (this.posts.length === 0) {
      this.host.innerHTML = `<div class="scheduled-post__empty">${_('No scheduled posts yet.')}</div>`;
      return;
    }

    this.host.innerHTML = this.posts.map(p => this.renderRow(p)).join('');
    this.host.querySelectorAll('[data-action="cancel"]').forEach(btn => {
      btn.addEventListener('click', async e => {
        const row = (e.currentTarget as HTMLElement).closest(
          '[data-id]'
        ) as HTMLElement;
        const id = row?.dataset.id;
        if (!id) return;
        await this.handleCancel(id);
      });
    });
  }

  private renderRow(p: ScheduledPost): string {
    const when = new Date(p.publishAt * 1000).toLocaleString();
    const kindLabel =
      p.kind === 30023 ? _('Article') : p.kind === 1068 ? _('Poll') : _('Note');
    const preview = p.content.length >= 100 ? `${p.content}…` : p.content;
    return `
      <div class="ui-list__item scheduled-post" data-id="${escapeHtml(p.id)}">
        <div class="scheduled-post__meta">
          <span class="scheduled-post__when">${escapeHtml(when)}</span>
          <span class="scheduled-post__kind">${kindLabel}</span>
        </div>
        <div class="scheduled-post__preview">${escapeHtml(preview || _('(empty)'))}</div>
        <div class="scheduled-post__actions">
          <button class="btn btn--passive btn--medium" data-action="cancel">${_('Cancel')}</button>
        </div>
      </div>
    `;
  }

  private async handleCancel(id: string): Promise<void> {
    const confirmed = await ModalService.getInstance().confirm({
      title: _('Cancel Scheduled Post'),
      message: _(
        'This will permanently remove the scheduled post. The event will not be published.'
      ),
      confirmText: _('Cancel Post'),
      cancelText: _('Keep'),
      confirmDestructive: true,
    });
    if (!confirmed) return;

    const auth = AuthService.getInstance();
    const user = auth.getCurrentUser();
    if (!user) {
      ToastService.show(_('Not authenticated'), 'error');
      return;
    }

    try {
      const challenge = await auth.signEvent({
        kind: 22242,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['challenge', id]],
        content: '',
        pubkey: user.pubkey,
      });
      if (!challenge) {
        ToastService.show(_('Failed to sign cancel challenge'), 'error');
        return;
      }
      await ScheduledPostService.getInstance().cancel(
        user.pubkey,
        id,
        challenge
      );
      const { diagLog } = await import('../../services/DiagnosticLogger');
      diagLog('system', 'scheduled_post_cancelled', { id });
      this.posts = this.posts.filter(p => p.id !== id);
      this.render();
      TypedEventBus.getInstance().emit('scheduled-posts:changed');
      ToastService.show(_('Scheduled post cancelled'), 'success');
    } catch (err) {
      SystemLogger.getInstance().warn(
        'ScheduledPostsList',
        `Cancel failed: ${String(err)}`
      );
      ToastService.show(_('Cancel failed: %s', String(err)), 'error');
    }
  }
}
