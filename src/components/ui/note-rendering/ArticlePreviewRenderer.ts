/**
 * ArticlePreviewRenderer Service
 * Renders preview cards for addressable events (NIP-23 articles, Zapstore apps, etc.)
 * Used by QuoteRenderer and OriginalNoteRenderer when encountering naddr references
 */

import type { NostrEvent, NDKFilter, NDKKind } from '@nostr-dev-kit/ndk';
import { ModuleLoader } from '../../../core/ModuleLoader';
import type { ArticlesModuleApi } from '../../../modules/articles/contracts';
import { Router } from '../../../services/Router';
import { getViewNavigationController } from '../../../services/ViewNavigationController';
import { escapeHtml, escapeHtmlAttr } from '../../../helpers/escapeHtml';
import { isLiveStreamsPlayerEnabled } from '../../../addons/live-streams-player/index';
import { getAddressableIdentifier } from '../../../helpers/getAddressableIdentifier';
import { getLiveStreamHost } from '../../../helpers/getLiveStreamHost';
import { ZapManager } from '../../../components/ui/interaction-managers/ZapManager';
import { LiveChatService } from '../../../services/LiveChatService';
import { RelayConfig } from '../../../services/RelayConfig';
import { NostrTransport } from '../../../services/transport/NostrTransport';

export class ArticlePreviewRenderer {
  private static instance: ArticlePreviewRenderer;
  private constructor() {}

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
      // The article (long-form) module is lazy-loaded; ensure it on demand so
      // previews work on the minimal public-page boot too (see ProfileArticlesCarousel).
      const api = await ModuleLoader.getInstance().ensure<ArticlesModuleApi>('articles');
      const event = (await api?.fetchAddressableEvent(naddrRef)) ?? null;

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

    // Zap button — only for live streams. Zaps the kind 30311 event
    // directly (via #a tag) so it appears in the stream provider's overlay.
    if (status === 'live') {
      const addressableId = getAddressableIdentifier(event);
      // For provider-signed events, the real streamer is in a p tag with role
      // "host"; event.pubkey is the provider service.
      const hostPubkey = getLiveStreamHost(event);
      if (addressableId && event.id) {
        const streamRelays = (event.tags.find(t => t[0] === 'relays')?.slice(1) || [])
          .filter((url): url is string => typeof url === 'string' && url.startsWith('ws'));
        if (isLiveStreamsPlayerEnabled()) {
          this.attachStreamChatInput(card, addressableId, streamRelays);
        }
        this.attachStreamZapButton(card, addressableId, hostPubkey, event.id);
        this.watchStreamStatus(card, event, streamRelays);
      }
    }

    return card;
  }

  /**
   * Subscribe to replaceable updates of the kind 30311 event. When status
   * transitions away from "live", remove chat input + zap wrapper immediately
   * so users can't send late messages/zaps after the stream ends.
   */
  private watchStreamStatus(card: HTMLElement, event: NostrEvent, streamRelays: string[]): void {
    const dTag = event.tags.find(t => t[0] === 'd')?.[1];
    if (!dTag) return;

    const transport = NostrTransport.getInstance();
    const relays = streamRelays.length > 0 ? streamRelays : transport.getReadRelays();
    const subId = `live-stream-status-${event.id}`;
    const baseCreatedAt = event.created_at;

    const cleanup = () => {
      transport.unsubscribeLive(subId);
      observer.disconnect();
    };

    const removeInteractiveElements = () => {
      card.querySelector('.live-stream-card__chat')?.remove();
      card.querySelector('.live-stream-card__zap-wrapper')?.remove();
    };

    const observer = new MutationObserver(() => {
      if (!document.contains(card)) {
        cleanup();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const filters: NDKFilter[] = [{
      kinds: [30311 as NDKKind],
      authors: [event.pubkey],
      '#d': [dTag],
    }];

    void transport.subscribeLive(
      relays,
      filters,
      subId,
      (incoming) => {
        if (incoming.created_at < baseCreatedAt) return;
        const newStatus = (incoming.tags.find(t => t[0] === 'status')?.[1] || '').toLowerCase();
        if (newStatus && newStatus !== 'live') {
          removeInteractiveElements();
          cleanup();
        }
      }
    );
  }

  /**
   * Attach a NIP-53 kind 1311 chat input to the live stream card.
   * Messages are tagged with the stream's addressable `a` tag so they appear
   * in the provider's overlay (e.g. zap.stream).
   */
  private attachStreamChatInput(card: HTMLElement, addressableId: string, streamRelays: string[]): void {
    const contentEl = card.querySelector('.live-stream-card__content');
    if (!contentEl) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'live-stream-card__chat';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'input live-stream-card__chat-input';
    input.placeholder = 'Send a message…';
    input.maxLength = 500;

    const sendBtn = document.createElement('button');
    sendBtn.className = 'btn btn--mini live-stream-card__chat-send';
    sendBtn.type = 'button';
    sendBtn.textContent = 'Send';

    wrapper.appendChild(input);
    wrapper.appendChild(sendBtn);
    contentEl.appendChild(wrapper);

    const send = async () => {
      const content = input.value.trim();
      if (!content || sendBtn.disabled) return;

      sendBtn.disabled = true;
      input.disabled = true;

      try {
        const writeRelays = await RelayConfig.getInstance().getWriteRelays();
        const mergedRelays = Array.from(new Set([...writeRelays, ...streamRelays]));
        const result = await LiveChatService.getInstance().publishMessage({
          addressableId,
          content,
          relays: mergedRelays,
        });
        if (result.success) {
          input.value = '';
        }
      } finally {
        sendBtn.disabled = false;
        input.disabled = false;
        input.focus();
      }
    };

    sendBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void send();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        void send();
      }
    });
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

      const { mountPlayer } = await import('../../../addons/live-streams-player/player');
      await mountPlayer(playerEl, { streamUrl, poster });
    } catch (err) {
      console.warn('[LiveStreamsPlayer] Failed to mount inline player:', err);
    }
  }

  /**
   * Attach a zap button to the live stream card.
   * Zaps the kind 30311 event directly (via #a tag) so the zap
   * appears in the stream provider's overlay (e.g. zap.stream).
   */
  private attachStreamZapButton(
    card: HTMLElement,
    addressableId: string,
    authorPubkey: string,
    eventId: string
  ): void {
    const contentEl = card.querySelector('.live-stream-card__content');
    if (!contentEl) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'live-stream-card__zap-wrapper';

    const zapBtn = document.createElement('button');
    zapBtn.className = 'live-stream-card__zap';
    zapBtn.setAttribute('data-action', 'stream-zap');
    zapBtn.innerHTML = `
      <span class="isl-icon"><svg width="18" height="18"><use href="#icon-zap"/></svg></span>
      <span>Zap Stream</span>
    `;

    wrapper.appendChild(zapBtn);
    contentEl.appendChild(wrapper);

    const zapManager = new ZapManager({
      noteId: addressableId,
      authorPubkey,
      articleEventId: eventId,
    });

    zapManager.attachEventListeners(zapBtn);

    // Show disabled reason as text below the button instead of title tooltip
    const observer = new MutationObserver(() => {
      if (zapBtn.title && zapBtn.hasAttribute('disabled')) {
        const hint = document.createElement('span');
        hint.className = 'live-stream-card__zap-hint';
        hint.textContent = zapBtn.title;
        zapBtn.removeAttribute('title');
        wrapper.appendChild(hint);
        observer.disconnect();
      }
    });
    observer.observe(zapBtn, { attributes: true, attributeFilter: ['disabled'] });

    zapManager.checkRecipientCanReceiveZaps();
  }

  /**
   * Article preview card (kind 30023)
   */
  private createArticlePreviewCard(event: NostrEvent, naddrRef: string): HTMLElement {
    const metadata = ModuleLoader.getInstance().getApi<ArticlesModuleApi>('articles')?.extractArticleMetadata(event)
      ?? { title: '', image: '', summary: '', publishedAt: 0, identifier: '', topics: [] };

    const card = document.createElement('div');
    card.className = 'article-preview-card';
    card.style.cursor = 'pointer';
    card.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.note-image--clickable, .note-media, video')) return;
      e.stopPropagation();
      const cleanNaddr = naddrRef.replace(/^nostr:/, '');
      // Route through the central controller so right-pane mode opens the article
      // in the secondary pane (scc) instead of navigating the timeline (pcc).
      getViewNavigationController().openView('article', cleanNaddr, e);
    });

    card.innerHTML = `
      ${metadata.image ? `<div class="article-preview-image"></div>` : ''}
      <div class="article-preview-content">
        <h3 class="article-preview-title">${escapeHtml(metadata.title)}</h3>
        ${metadata.summary ? `<p class="article-preview-summary">${escapeHtml(metadata.summary)}</p>` : ''}
      </div>
    `;

    if (metadata.image) {
      const imgDiv = card.querySelector('.article-preview-image') as HTMLElement | null;
      if (imgDiv) imgDiv.style.backgroundImage = `url(${JSON.stringify(metadata.image)})`;
    }

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
      if ((e.target as HTMLElement).closest('.note-image--clickable, .note-media, video')) return;
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
