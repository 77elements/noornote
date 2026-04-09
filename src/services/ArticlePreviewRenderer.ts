/**
 * ArticlePreviewRenderer Service
 * Renders preview cards for addressable events (NIP-23 articles, Zapstore apps, etc.)
 * Used by QuoteRenderer and OriginalNoteRenderer when encountering naddr references
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { LongFormOrchestrator } from './orchestration/LongFormOrchestrator';
import { Router } from './Router';
import { escapeHtml, escapeHtmlAttr } from '../helpers/escapeHtml';
import { isLiveStreamsPlayerEnabled } from '../addons/live-streams-player/index';

export class ArticlePreviewRenderer {
  private static instance: ArticlePreviewRenderer;
  private orchestrator: LongFormOrchestrator;

  private constructor() {
    this.orchestrator = LongFormOrchestrator.getInstance();
  }

  static getInstance(): ArticlePreviewRenderer {
    if (!ArticlePreviewRenderer.instance) {
      ArticlePreviewRenderer.instance = new ArticlePreviewRenderer();
    }
    return ArticlePreviewRenderer.instance;
  }

  /**
   * Render addressable event preview card (NON-BLOCKING)
   * Creates skeleton immediately, fetches in background
   */
  public renderArticlePreview(naddrRef: string, container: Element): void {
    const skeleton = this.createArticleSkeleton();
    skeleton.dataset.naddrRef = naddrRef;
    container.appendChild(skeleton);

    this.fetchAndRender(naddrRef, skeleton);
  }

  private async fetchAndRender(naddrRef: string, skeleton: HTMLElement): Promise<void> {
    try {
      const event = await this.orchestrator.fetchAddressableEvent(naddrRef);

      if (event) {
        const previewCard = this.createPreviewCard(event, naddrRef);
        skeleton.replaceWith(previewCard);
      } else {
        const errorElement = this.createArticleError();
        skeleton.replaceWith(errorElement);
      }
    } catch (error) {
      console.debug('Addressable event fetch failed:', error);
      skeleton.remove();
    }
  }

  private createPreviewCard(event: NostrEvent, naddrRef: string): HTMLElement {
    if (event.kind === 32267) {
      return this.createZapstorePreviewCard(event, naddrRef);
    }
    if (event.kind === 30311) {
      return this.createLiveStreamCard(event, naddrRef);
    }
    return this.createArticlePreviewCard(event, naddrRef);
  }

  /**
   * Live Activity / Live Stream card (NIP-53 kind 30311)
   * Tags: title, summary, image, streaming, status, starts, ends, p (host)
   */
  private createLiveStreamCard(event: NostrEvent, naddrRef: string): HTMLElement {
    const tags = event.tags;
    const getTag = (name: string) => tags.find(t => t[0] === name)?.[1] || '';
    const title = getTag('title') || 'Untitled Stream';
    const summary = getTag('summary');
    const image = getTag('image');
    const status = (getTag('status') || 'planned').toLowerCase(); // 'live' | 'planned' | 'ended'
    const recording = getTag('recording');
    const streaming = getTag('streaming'); // HLS URL for the inline player

    // Fallback watch URL: prefer zap.stream (the most common provider) — deep-links
    // via naddr so zap.stream resolves it from relays. When status=ended and a
    // recording tag is present, link directly to the recording.
    const cleanNaddr = naddrRef.replace(/^nostr:/, '');
    const watchUrl = status === 'ended' && recording
      ? recording
      : `https://zap.stream/${cleanNaddr}`;

    const statusLabel = status === 'live' ? 'LIVE'
      : status === 'ended' ? 'ENDED'
      : 'PLANNED';
    const watchLabel = status === 'live' ? 'Watch live'
      : status === 'ended' ? (recording ? 'Watch recording' : 'View on zap.stream')
      : 'View details';

    const card = document.createElement('div');
    card.className = `live-stream-card live-stream-card--${status}`;

    card.innerHTML = `
      ${image ? `
        <div class="live-stream-card__image">
          <img src="${escapeHtmlAttr(image)}" alt="${escapeHtmlAttr(title)}" loading="lazy" />
          <span class="live-stream-card__badge">${statusLabel}</span>
        </div>
      ` : `
        <div class="live-stream-card__image live-stream-card__image--placeholder">
          <span class="live-stream-card__badge">${statusLabel}</span>
        </div>
      `}
      <div class="live-stream-card__content">
        <h3 class="live-stream-card__title">${escapeHtml(title)}</h3>
        ${summary ? `<p class="live-stream-card__summary">${escapeHtml(summary)}</p>` : ''}
        <a class="btn live-stream-card__watch" href="${escapeHtml(watchUrl)}" target="_blank" rel="noopener noreferrer">${watchLabel}</a>
      </div>
    `;

    // Addon: Live Streams Player — inline HLS playback.
    // Only for currently-live streams with a streaming URL.
    if (status === 'live' && streaming && isLiveStreamsPlayerEnabled()) {
      this.upgradeToInlinePlayer(card, streaming, image);
    }

    return card;
  }

  /**
   * Upgrade a live-stream card to an inline HLS player.
   * Replaces the cover image with a <video> element using hls.js.
   * Gated by the Live Streams Player addon.
   */
  private async upgradeToInlinePlayer(
    card: HTMLElement,
    streamUrl: string,
    poster: string
  ): Promise<void> {
    try {
      const imageEl = card.querySelector('.live-stream-card__image') as HTMLElement | null;
      if (!imageEl) return;

      const badgeHtml = imageEl.querySelector('.live-stream-card__badge')?.outerHTML || '';
      const playerEl = document.createElement('div');
      playerEl.className = 'live-stream-card__image live-stream-card__image--player';
      playerEl.innerHTML = badgeHtml;
      imageEl.replaceWith(playerEl);

      // Hide the Watch button when the inline player is active.
      const watchBtn = card.querySelector('.live-stream-card__watch') as HTMLElement | null;
      if (watchBtn) watchBtn.style.display = 'none';

      const { mountPlayer } = await import('../addons/live-streams-player/player');
      await mountPlayer(playerEl, { streamUrl, poster });
    } catch (err) {
      console.warn('[LiveStreamsPlayer] Failed to mount inline player:', err);
    }
  }

  /**
   * Article preview card (kind 30023)
   */
  private createArticlePreviewCard(event: NostrEvent, naddrRef: string): HTMLElement {
    const metadata = LongFormOrchestrator.extractArticleMetadata(event);

    const card = document.createElement('div');
    card.className = 'article-preview-card';
    card.style.cursor = 'pointer';
    card.addEventListener('click', (e) => {
      e.stopPropagation();
      const cleanNaddr = naddrRef.replace(/^nostr:/, '');
      Router.getInstance().navigate(`/article/${cleanNaddr}`);
    });

    card.innerHTML = `
      ${metadata.image ? `
        <div class="article-preview-image">
          <img src="${metadata.image}" alt="${escapeHtml(metadata.title)}" loading="lazy" />
        </div>
      ` : ''}
      <div class="article-preview-content">
        <h3 class="article-preview-title">${escapeHtml(metadata.title)}</h3>
        ${metadata.summary ? `<p class="article-preview-summary">${escapeHtml(metadata.summary)}</p>` : ''}
      </div>
    `;

    return card;
  }

  /**
   * Zapstore app preview card (kind 32267)
   */
  private createZapstorePreviewCard(event: NostrEvent, naddrRef: string): HTMLElement {
    const tags = event.tags;
    const getTag = (name: string) => tags.find(t => t[0] === name)?.[1] || '';
    const name = getTag('name') || 'Untitled App';
    const summary = getTag('summary');
    const icon = getTag('icon');

    const card = document.createElement('div');
    card.className = 'article-preview-card';
    card.style.cursor = 'pointer';
    card.addEventListener('click', (e) => {
      e.stopPropagation();
      const cleanNaddr = naddrRef.replace(/^nostr:/, '');
      Router.getInstance().navigate(`/zapstore/${cleanNaddr}`);
    });

    card.innerHTML = `
      ${icon ? `
        <div class="article-preview-image" style="display: flex; align-items: center; justify-content: center; padding: calc(var(--gap, 1rem) / 2); background: transparent;">
          <img src="${escapeHtmlAttr(icon)}" alt="${escapeHtmlAttr(name)}" loading="lazy" style="width: 64px; height: 64px; border-radius: 8px; object-fit: contain;" />
        </div>
      ` : ''}
      <div class="article-preview-content">
        <h3 class="article-preview-title">${escapeHtml(name)}</h3>
        ${summary ? `<p class="article-preview-summary">${escapeHtml(summary)}</p>` : ''}
      </div>
    `;

    return card;
  }

  private createArticleError(): HTMLElement {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'article-preview-error';
    errorDiv.innerHTML = `
      <div class="article-error-content">
        <span class="error-icon">⚠️</span>
        <span class="error-text">Failed to load article</span>
      </div>
    `;
    return errorDiv;
  }

  private createArticleSkeleton(): HTMLElement {
    const skeleton = document.createElement('div');
    skeleton.className = 'article-preview-skeleton';
    skeleton.innerHTML = `
      <div class="skeleton-image"></div>
      <div class="skeleton-content">
        <div class="skeleton-line skeleton-title"></div>
        <div class="skeleton-line skeleton-summary"></div>
        <div class="skeleton-line skeleton-summary short"></div>
      </div>
    `;
    return skeleton;
  }

}
