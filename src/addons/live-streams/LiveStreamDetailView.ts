/**
 * LiveStreamDetailView
 *
 * Dedicated detail page for a single NIP-53 live stream (kind 30311),
 * route `/addons/live-streams/stream/<naddr>`. Shows ONLY this stream —
 * title + the shared stream card (incl. the inline HLS player upgrade
 * from ArticlePreviewRenderer). Deliberately NOT an SNV.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { View } from '../../components/views/View';
import { ModuleLoader } from '../../core/ModuleLoader';
import { TypedEventBus } from '../../core/TypedEventBus';
import type { ArticlesModuleApi } from '../../modules/articles/contracts';
import { ArticlePreviewRenderer } from '../../components/ui/note-rendering/ArticlePreviewRenderer';
import { backgroundPlayer, BackgroundPlayer } from './backgroundPlayer';
import { escapeHtml } from '../../helpers/escapeHtml';
import { _ } from '../../i18n';

export class LiveStreamDetailView extends View {
  private container: HTMLElement;
  /** Cached so the background-player subscription can re-render the
   * stream card when the pin is released while this view is open. */
  private currentEvent: NostrEvent | null = null;
  private currentNaddr: string | null = null;
  /** True after "Play in background" removed the inline player DOM —
   * the unpin re-render only restores the card that was removed. */
  private inlinePlayerRemoved = false;
  private bgPlayerSubId: string | null = null;

  constructor(naddr: string) {
    super();
    this.container = document.createElement('div');
    this.container.className =
      'view-content view-content--addon view-content--live-stream-detail';

    this.container.innerHTML = `
      <div class="back-padder focus-flow-root">
        <div class="live-stream-detail" data-detail-mount>
          <p class="live-stream-detail__loading pulsate">${_('Loading stream…')}</p>
        </div>
      </div>
    `;

    // The "Play in background" click removes the inline player DOM from
    // this view. When the stream is later unpinned (widget close / stop)
    // while the user is still on this view, nothing re-rendered — the
    // card stayed gone. Rebuild the detail content on unpin.
    this.bgPlayerSubId = TypedEventBus.getInstance().on(
      'live-streams:background-player',
      (data: { pinned: boolean }) => {
        if (!data?.pinned && this.inlinePlayerRemoved) {
          this.renderDetail();
        }
      }
    );

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

      this.currentEvent = event;
      this.currentNaddr = naddr;
      this.renderDetail();
    } catch {
      mount.innerHTML = `<p class="live-stream-detail__error">${_('Stream not found on your relays.')}</p>`;
    }
  }

  /**
   * Build the detail content (title + stream card + pin button) for the
   * cached event. Called on load and again when the background player
   * releases the stream (restores the inline player that was removed).
   */
  private renderDetail(): void {
    const event = this.currentEvent;
    const naddr = this.currentNaddr;
    if (!event || !naddr) return;
    const mount = this.container.querySelector('[data-detail-mount]');
    if (!mount) return;

    const title = event.tags.find(t => t[0] === 'title')?.[1];
    mount.innerHTML = `
      ${title ? `<h1>${escapeHtml(title)}</h1>` : ''}
      <div class="live-stream-detail__stream" data-stream-mount></div>
      <div class="live-stream-detail__pin-mount" data-pin-mount></div>
    `;

    const streamMount = mount.querySelector('[data-stream-mount]');
    if (streamMount) {
      ArticlePreviewRenderer.getInstance().renderFromEvent(event, streamMount);
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
        // The pin always takes the inline player out of this view (even
        // when the player DOM was already gone, e.g. replaced by the
        // player upgrade) — the unpin re-render relies on this flag.
        this.inlinePlayerRemoved = true;
        await backgroundPlayer.pin(pinData);
      });
      pinMount.appendChild(btn);
    }
    this.inlinePlayerRemoved = false;
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    if (this.bgPlayerSubId) {
      TypedEventBus.getInstance().off(this.bgPlayerSubId);
      this.bgPlayerSubId = null;
    }
    this.currentEvent = null;
    this.currentNaddr = null;
    this.container.innerHTML = '';
  }
}
