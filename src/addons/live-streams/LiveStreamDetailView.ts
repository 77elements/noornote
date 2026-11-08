/**
 * LiveStreamDetailView
 *
 * Dedicated detail page for a single NIP-53 live stream (kind 30311),
 * route `/addons/live-streams/stream/<naddr>`. Shows ONLY this stream —
 * title + the shared stream card (incl. the inline HLS player upgrade
 * from ArticlePreviewRenderer). Deliberately NOT an SNV.
 */

import { View } from '../../components/views/View';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { ArticlesModuleApi } from '../../modules/articles/contracts';
import { ArticlePreviewRenderer } from '../../components/ui/note-rendering/ArticlePreviewRenderer';
import { backgroundPlayer, BackgroundPlayer } from './backgroundPlayer';
import { escapeHtml } from '../../helpers/escapeHtml';
import { _ } from '../../i18n';

export class LiveStreamDetailView extends View {
  private container: HTMLElement;

  constructor(naddr: string) {
    super();
    this.container = document.createElement('div');
    this.container.className =
      'view-content view-content--addon view-content--live-stream-detail';

    this.container.innerHTML = `
      <div class="back-padder">
        <div class="live-stream-detail" data-detail-mount>
          <p class="live-stream-detail__loading pulsate">${_('Loading stream…')}</p>
        </div>
      </div>
    `;

    void this.load(naddr);
  }

  private async load(naddr: string): Promise<void> {
    const mount = this.container.querySelector('[data-detail-mount]');
    if (!mount) return;

    try {
      const api =
        await ModuleLoader.getInstance().ensure<ArticlesModuleApi>('articles');
      const event =
        (await api?.fetchAddressableEvent(`nostr:${naddr}`)) ?? null;

      if (!event) {
        mount.innerHTML = `<p class="live-stream-detail__error">${_('Stream not found on your relays.')}</p>`;
        return;
      }

      const title = event.tags.find(t => t[0] === 'title')?.[1];
      mount.innerHTML = `
        ${title ? `<h1>${escapeHtml(title)}</h1>` : ''}
        <div class="live-stream-detail__stream" data-stream-mount></div>
        <div class="live-stream-detail__pin-mount" data-pin-mount></div>
      `;

      const streamMount = mount.querySelector('[data-stream-mount]');
      if (streamMount) {
        ArticlePreviewRenderer.getInstance().renderFromEvent(
          event,
          streamMount
        );
      }

      // "Play in background" — for podcasts / radio streams with a static
      // image. Hands the stream to the background player (sidebar mini
      // player, audio-only) and stops the inline player. Requires a
      // `streaming` URL and a user gesture (this click).
      const pinData = BackgroundPlayer.fromEvent(event, naddr);
      const pinMount = mount.querySelector('[data-pin-mount]');
      if (pinData && pinMount) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn live-stream-detail__pin-btn';
        btn.textContent = _('Play in background');
        btn.addEventListener('click', async () => {
          // Stop the inline player first — one audio source at a time.
          const inlineVideo = this.container.querySelector(
            '.live-stream-player__video'
          ) as HTMLVideoElement | null;
          if (inlineVideo) {
            try {
              inlineVideo.pause();
            } catch {
              /* ignore */
            }
            inlineVideo.closest('.live-stream-card__image')?.remove();
          }
          await backgroundPlayer.pin(pinData);
        });
        pinMount.appendChild(btn);
      }
    } catch {
      mount.innerHTML = `<p class="live-stream-detail__error">${_('Stream not found on your relays.')}</p>`;
    }
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.container.innerHTML = '';
  }
}
