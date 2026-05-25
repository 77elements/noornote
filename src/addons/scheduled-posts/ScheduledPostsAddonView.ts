/**
 * ScheduledPostsAddonView
 *
 * View for the Scheduled Posts addon page (`/addons/scheduled-posts`):
 * shows the enable toggle on top, followed by a list of pending scheduled
 * posts below — but only while the addon is enabled.
 */

import { View } from '../../components/views/View';
import { Switch } from '../../components/ui/Switch';
import { EventBus } from '../../services/EventBus';
import { ToastService } from '../../services/ToastService';
import { ModalService } from '../../services/ModalService';
import { AuthService } from '../../services/AuthService';
import { SystemLogger } from '../../services/SystemLogger';
import { escapeHtml } from '../../helpers/escapeHtml';
import { isScheduledPostsEnabled, setScheduledPostsEnabled } from './index';
import { ScheduledPostService, type ScheduledPost } from './ScheduledPostService';

export class ScheduledPostsAddonView extends View {
  private container: HTMLElement;
  private contentEl: HTMLElement | null = null;
  private enableSwitch: Switch | null = null;
  private toggleSubId: string | null = null;
  private changedSubId: string | null = null;
  private posts: ScheduledPost[] = [];
  private loading: boolean = false;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--addon view-content--addon-scheduled-posts';

    const enabled = isScheduledPostsEnabled();

    this.enableSwitch = new Switch({
      label: '',
      checked: enabled,
      onChange: (checked) => {
        setScheduledPostsEnabled(checked);
        EventBus.getInstance().emit('scheduled-posts:addon-toggle', { enabled: checked });
        ToastService.show(
          checked ? 'Scheduled Posts enabled' : 'Scheduled Posts disabled',
          'success'
        );
        if (checked) this.mountList();
        else this.unmountList();
      },
    });

    this.container.innerHTML = `
      <h1>Scheduled Posts</h1>
      <section class="section">
        <div class="setting">
          <span class="setting__label">Enable Scheduled Posts</span>
          <div class="setting__control"></div>
          <p class="setting__desc">Schedule notes and articles to be published at a later date and time. Your fully signed event is held by a NoorNote-operated Deno service and published to your chosen relays at the scheduled moment. No private keys leave your device.</p>
        </div>
      </section>
      <div data-addon-content="scheduled-posts"></div>
    `;

    const controlEl = this.container.querySelector('.setting__control');
    if (controlEl) controlEl.innerHTML = this.enableSwitch.render();
    this.enableSwitch.setupEventListeners(this.container);

    this.contentEl = this.container.querySelector('[data-addon-content="scheduled-posts"]');

    if (enabled) {
      this.mountList();
    }

    this.toggleSubId = EventBus.getInstance().on('scheduled-posts:addon-toggle', (payload: { enabled: boolean }) => {
      if (payload.enabled) this.mountList();
      else this.unmountList();
    });

    // Refresh the list whenever a post is scheduled or cancelled elsewhere.
    this.changedSubId = EventBus.getInstance().on('scheduled-posts:changed', () => {
      if (isScheduledPostsEnabled()) {
        void this.loadAndRenderList();
      }
    });
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    if (this.toggleSubId) {
      EventBus.getInstance().off(this.toggleSubId);
      this.toggleSubId = null;
    }
    if (this.changedSubId) {
      EventBus.getInstance().off(this.changedSubId);
      this.changedSubId = null;
    }
    this.enableSwitch?.destroy();
    this.enableSwitch = null;
    this.unmountList();
    this.contentEl = null;
    this.container.innerHTML = '';
  }

  private mountList(): void {
    if (!this.contentEl) return;
    this.contentEl.innerHTML = `
      <h2>Your scheduled posts</h2>
      <div class="ui-list" data-list></div>
    `;
    void this.loadAndRenderList();
  }

  private unmountList(): void {
    if (this.contentEl) this.contentEl.innerHTML = '';
    this.posts = [];
    this.loading = false;
  }

  private async loadAndRenderList(): Promise<void> {
    const user = AuthService.getInstance().getCurrentUser();
    if (!user) {
      this.posts = [];
      this.renderList();
      return;
    }
    this.loading = true;
    this.renderList();
    try {
      this.posts = await ScheduledPostService.getInstance().getScheduled(user.pubkey);
      this.posts.sort((a, b) => a.publishAt - b.publishAt);
    } catch (err) {
      SystemLogger.getInstance().warn('ScheduledPostsAddonView', `Failed to load list: ${err}`);
      this.posts = [];
      ToastService.show('Failed to load scheduled posts', 'error');
    } finally {
      this.loading = false;
      this.renderList();
    }
  }

  private renderList(): void {
    const list = this.container.querySelector('[data-list]') as HTMLElement | null;
    if (!list) return;

    if (this.loading) {
      list.innerHTML = `<div class="scheduled-post__empty pulsate">Loading scheduled posts...</div>`;
      return;
    }

    if (this.posts.length === 0) {
      list.innerHTML = `<div class="scheduled-post__empty">No scheduled posts yet.</div>`;
      return;
    }

    list.innerHTML = this.posts.map((p) => this.renderRow(p)).join('');
    this.attachRowListeners();
  }

  private renderRow(p: ScheduledPost): string {
    const when = new Date(p.publishAt * 1000).toLocaleString();
    const kindLabel = p.kind === 30023 ? 'Article' : p.kind === 1068 ? 'Poll' : 'Note';
    const preview = p.content.length >= 100 ? `${p.content}…` : p.content;
    return `
      <div class="ui-list__item scheduled-post" data-id="${escapeHtml(p.id)}">
        <div class="scheduled-post__meta">
          <span class="scheduled-post__when">${escapeHtml(when)}</span>
          <span class="scheduled-post__kind">${kindLabel}</span>
        </div>
        <div class="scheduled-post__preview">${escapeHtml(preview || '(empty)')}</div>
        <div class="scheduled-post__actions">
          <button class="btn btn--passive btn--medium" data-action="cancel">Cancel</button>
        </div>
      </div>
    `;
  }

  private attachRowListeners(): void {
    const list = this.container.querySelector('[data-list]');
    if (!list) return;
    list.querySelectorAll('[data-action="cancel"]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const row = (e.currentTarget as HTMLElement).closest('[data-id]') as HTMLElement;
        const id = row?.dataset.id;
        if (!id) return;
        await this.handleCancel(id);
      });
    });
  }

  private async handleCancel(id: string): Promise<void> {
    const confirmed = await ModalService.getInstance().confirm({
      title: 'Cancel Scheduled Post',
      message: 'This will permanently remove the scheduled post. The event will not be published.',
      confirmText: 'Cancel Post',
      cancelText: 'Keep',
      confirmDestructive: true,
    });
    if (!confirmed) return;

    const auth = AuthService.getInstance();
    const user = auth.getCurrentUser();
    if (!user) {
      ToastService.show('Not authenticated', 'error');
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
        ToastService.show('Failed to sign cancel challenge', 'error');
        return;
      }
      await ScheduledPostService.getInstance().cancel(user.pubkey, id, challenge);
      const { diagLog } = await import('../../services/DiagnosticLogger');
      diagLog('system', 'scheduled_post_cancelled', { id });
      this.posts = this.posts.filter((p) => p.id !== id);
      this.renderList();
      EventBus.getInstance().emit('scheduled-posts:changed', {});
      ToastService.show('Scheduled post cancelled', 'success');
    } catch (err) {
      SystemLogger.getInstance().warn('ScheduledPostsAddonView', `Cancel failed: ${err}`);
      ToastService.show(`Cancel failed: ${err}`, 'error');
    }
  }
}
