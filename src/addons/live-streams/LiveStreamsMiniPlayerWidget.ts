/**
 * LiveStreamsMiniPlayerWidget — sidebar mini player for the pinned
 * background stream (podcasts / radio stations with a static image).
 *
 * Mounts into the static sidebar slot `[data-sidebar-widget="live-streams-mini-player"]`
 * (MainLayout, below the "currently live" widget). Shows ONLY when a stream
 * is pinned: title (→ detail page) | play/pause | stop (unpin).
 *
 * State comes from the backgroundPlayer singleton; re-renders on its
 * TypedEventBus event. Survives reloads in PAUSED state (autoplay policy).
 */

import { backgroundPlayer } from './backgroundPlayer';
import { TypedEventBus } from '../../core/TypedEventBus';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { _ } from '../../i18n';

export class LiveStreamsMiniPlayerWidget {
  private el: HTMLElement | null = null;
  private subId: string | null = null;
  private destroyed = false;

  constructor() {
    this.subId = TypedEventBus.getInstance().on(
      'live-streams:background-player',
      () => this.render()
    );
    this.render();
  }

  private render(): void {
    if (this.destroyed) return;
    const container = document.querySelector(
      '[data-sidebar-widget="live-streams-mini-player"]'
    );
    if (!container) return;

    const { pinned, playing } = backgroundPlayer.getState();
    if (!pinned) {
      this.el?.remove();
      this.el = null;
      return;
    }

    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'sidebar-widget live-streams-mini-player';
      container.appendChild(this.el);
      this.el.addEventListener('click', this.onClick);
    }

    this.el.innerHTML = `
      <a class="live-streams-mini-player__title" href="/addons/live-streams/stream/${escapeHtmlAttr(pinned.naddr)}">${escapeHtml(pinned.title || _('Untitled Stream'))}</a>
      <button type="button" class="btn btn--passive btn--mini live-streams-mini-player__btn" data-action="toggle-play" aria-label="${playing ? _('Pause') : _('Play')}">
        <svg width="14" height="14"><use href="#${playing ? 'icon-pause' : 'icon-play'}"/></svg>
      </button>
      <button type="button" class="btn btn--passive btn--mini live-streams-mini-player__btn" data-action="stop" aria-label="${_('Stop')}">
        <svg width="14" height="14"><use href="#icon-close"/></svg>
      </button>
    `;
  }

  private onClick = (e: MouseEvent): void => {
    const target = (e.target as HTMLElement | null)?.closest<HTMLElement>(
      '[data-action]'
    );
    if (!target) return; // title link → global anchor handling navigates
    e.preventDefault();
    if (target.dataset.action === 'toggle-play') backgroundPlayer.toggle();
    else if (target.dataset.action === 'stop') backgroundPlayer.stop();
  };

  public refresh(): void {
    this.render();
  }

  public destroy(): void {
    this.destroyed = true;
    if (this.subId) {
      TypedEventBus.getInstance().off(this.subId);
      this.subId = null;
    }
    this.el?.removeEventListener('click', this.onClick);
    this.el?.remove();
    this.el = null;
  }
}
