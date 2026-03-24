/**
 * ArticlePreviewRenderer Service
 * Renders preview cards for addressable events (NIP-23 articles, Zapstore apps, etc.)
 * Used by QuoteRenderer and OriginalNoteRenderer when encountering naddr references
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { LongFormOrchestrator } from './orchestration/LongFormOrchestrator';
import { Router } from './Router';

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
    return this.createArticlePreviewCard(event, naddrRef);
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
          <img src="${metadata.image}" alt="${this.escapeHtml(metadata.title)}" loading="lazy" />
        </div>
      ` : ''}
      <div class="article-preview-content">
        <h3 class="article-preview-title">${this.escapeHtml(metadata.title)}</h3>
        ${metadata.summary ? `<p class="article-preview-summary">${this.escapeHtml(metadata.summary)}</p>` : ''}
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
          <img src="${icon}" alt="${this.escapeHtml(name)}" loading="lazy" style="width: 64px; height: 64px; border-radius: 8px; object-fit: contain;" />
        </div>
      ` : ''}
      <div class="article-preview-content">
        <h3 class="article-preview-title">${this.escapeHtml(name)}</h3>
        ${summary ? `<p class="article-preview-summary">${this.escapeHtml(summary)}</p>` : ''}
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

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
