/**
 * InteractionStatusLine (ISL) Component
 * Displays interaction stats and actions for a note: Reply, Repost, Like, Zap
 * Used in both Timeline View and Single Note View
 */

import { InteractionStatsService } from '../../services/InteractionStatsService';
import { AuthGuard } from '../../services/AuthGuard';
import { formatCount } from '../../helpers/formatCount';
import { ZapManager } from './interaction-managers/ZapManager';
import { LikeManager } from './interaction-managers/LikeManager';
import { RepostManager } from './interaction-managers/RepostManager';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

export interface ISLStats {
  replies: number;
  reposts: number;
  quotedReposts: number;
  likes: number;
  zaps: number;
}

export interface ISLConfig {
  noteId: string;
  authorPubkey?: string;   // Optional author pubkey for Hollywood-style logging
  stats?: ISLStats;
  fetchStats?: boolean;
  isLoggedIn?: boolean;    // User logged in - enables interactions (default: false)
  originalEvent?: NostrEvent; // Original event for reposting
  onReply?: () => void;
  onRepost?: () => void;
  onLike?: () => void;
  onZap?: () => void;
  onAnalytics?: () => void;
  /**
   * LONG-FORM ARTICLES ONLY: Event ID for addressable events
   * When zapping an article, noteId is the addressable identifier (kind:pubkey:d-tag)
   * and articleEventId is the actual event ID (hex). Both are needed for proper tagging.
   */
  articleEventId?: string;
}

export class InteractionStatusLine {
  private element: HTMLElement;
  private config: ISLConfig;
  private stats: ISLStats;
  private interactionStatsService: InteractionStatsService;
  private initialFetchPromise?: Promise<void>;
  private zapManager: ZapManager | null = null;
  private likeManager: LikeManager | null = null;
  private repostManager: RepostManager | null = null;

  constructor(config: ISLConfig) {
    this.config = config;
    this.interactionStatsService = InteractionStatsService.getInstance();

    // Initialize stats: use provided stats, or check cache (Timeline shows cached SNV stats)
    if (config.stats) {
      this.stats = config.stats;
    } else {
      const cachedStats = this.interactionStatsService.getCachedStats(config.noteId);
      if (cachedStats) {
        // Convert InteractionStats to ISLStats
        this.stats = {
          replies: cachedStats.replies,
          reposts: cachedStats.reposts,
          quotedReposts: cachedStats.quotedReposts,
          likes: cachedStats.likes,
          zaps: cachedStats.zaps
        };
      } else {
        this.stats = { replies: 0, reposts: 0, quotedReposts: 0, likes: 0, zaps: 0 };
      }
    }

    // Initialize managers first (before creating element)
    this.initializeManagers();

    this.element = this.createElement();

    // Check interaction states after DOM is ready
    this.checkInteractionStates();

    // Fetch stats in background if requested (SNV only)
    if (config.fetchStats) {
      this.initialFetchPromise = this.fetchStats();
    }
  }

  /**
   * Initialize interaction managers
   */
  private initializeManagers(): void {
    // Initialize ZapManager
    if (this.config.authorPubkey) {
      this.zapManager = new ZapManager({
        noteId: this.config.noteId,
        authorPubkey: this.config.authorPubkey,
        onStatsUpdate: (amount: number) => {
          this.updateStats({ zaps: this.stats.zaps + amount });
        },
        ...(this.config.articleEventId && { articleEventId: this.config.articleEventId }),
        ...(this.config.onZap && { onCustomZap: this.config.onZap })
      });
    }

    // Initialize LikeManager
    if (this.config.authorPubkey) {
      this.likeManager = new LikeManager({
        noteId: this.config.noteId,
        authorPubkey: this.config.authorPubkey,
        onStatsUpdate: () => {
          this.updateStats({ likes: this.stats.likes + 1 });
        },
        ...(this.config.onLike && { onLike: this.config.onLike }),
        // Pass the original event so reactions on addressable kinds
        // (long-form articles etc.) get NIP-25-compliant e/a/k tags.
        ...(this.config.originalEvent && { originalEvent: this.config.originalEvent }),
      });
    }

    // Initialize RepostManager (requires authorPubkey)
    if (this.config.authorPubkey) {
      this.repostManager = new RepostManager({
        noteId: this.config.noteId,
        authorPubkey: this.config.authorPubkey,
        onStatsUpdate: () => {
          this.updateStats({ reposts: this.stats.reposts + 1 });
        },
        ...(this.config.originalEvent && { originalEvent: this.config.originalEvent }),
        ...(this.config.onRepost && { onRepost: this.config.onRepost }),
        ...(this.config.onReply && { onQuote: this.config.onReply })
      });
    }
  }

  /**
   * Check interaction states (like/repost/zap) after DOM is created
   */
  private checkInteractionStates(): void {
    if (this.zapManager) {
      this.zapManager.checkZappedStatus();
      this.zapManager.checkRecipientCanReceiveZaps();
    }
    if (this.likeManager) {
      this.likeManager.checkLikedStatus();
    }
    if (this.repostManager) {
      this.repostManager.checkRepostedStatus();
    }
  }


  /**
   * Fetch interaction stats from relays (background task)
   */
  private async fetchStats(): Promise<void> {
    try {
      const stats = await this.interactionStatsService.getStats(
        this.config.noteId,
        this.config.authorPubkey
      );
      this.updateStats({
        replies: stats.replies,
        reposts: stats.reposts,
        quotedReposts: stats.quotedReposts,
        likes: stats.likes,
        zaps: stats.zaps
      });
    } catch (error) {
      console.warn('Failed to load interaction stats:', error);
    }
  }

  /**
   * Create ISL element
   */
  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'isl';
    container.dataset.noteId = this.config.noteId;

    const analyticsHtml = this.config.onAnalytics
      ? `<button class="isl-action isl-analytics" type="button" data-action="analytics">
           Analytics
         </button>`
      : '';

    container.innerHTML = `
      <button class="isl-action isl-reply" type="button" data-action="reply" title="Reply">
        <span class="isl-icon"><svg width="18" height="18"><use href="#icon-thread-bubble"/></svg></span>
        <span class="isl-count">${formatCount(this.stats.replies)}</span>
      </button>

      <button class="isl-action isl-zap" type="button" data-action="zap" title="Zap">
        <span class="isl-icon"><svg width="18" height="18"><use href="#icon-zap"/></svg></span>
        <span class="isl-count">${formatCount(this.stats.zaps)}</span>
      </button>

      <button class="isl-action isl-repost" type="button" data-action="repost" title="Repost">
        <span class="isl-icon"><svg width="18" height="18"><use href="#icon-repost"/></svg></span>
        <span class="isl-count">${formatCount(this.stats.reposts)}</span>
      </button>

      <button class="isl-action isl-quote" type="button" data-action="quote" title="Quoted Repost">
        <span class="isl-icon">❝</span>
        <span class="isl-count">${formatCount(this.stats.quotedReposts)}</span>
      </button>

      <button class="isl-action isl-like" type="button" data-action="like" title="Like">
        <span class="isl-icon">♡</span>
        <span class="isl-count">${formatCount(this.stats.likes)}</span>
      </button>

      ${analyticsHtml}
    `;

    this.attachEventListeners(container);

    return container;
  }

  /**
   * Attach event listeners to action buttons
   */
  private attachEventListeners(container: HTMLElement): void {
    const replyBtn = container.querySelector('[data-action="reply"]');
    const quoteBtn = container.querySelector('[data-action="quote"]');
    const repostBtn = container.querySelector('[data-action="repost"]');
    const likeBtn = container.querySelector('[data-action="like"]');
    const zapBtn = container.querySelector('[data-action="zap"]');
    const analyticsBtn = container.querySelector('[data-action="analytics"]');

    if (replyBtn) {
      replyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.handleReply();
      });
    }

    if (quoteBtn && this.repostManager) {
      this.repostManager.attachQuoteListener(quoteBtn as HTMLElement);
    }

    if (repostBtn && this.repostManager) {
      this.repostManager.attachRepostListener(repostBtn as HTMLElement);
    }

    if (likeBtn && this.likeManager) {
      this.likeManager.attachEventListeners(likeBtn as HTMLElement);
    }

    if (zapBtn && this.zapManager) {
      this.zapManager.attachEventListeners(zapBtn as HTMLElement);
    }

    if (analyticsBtn) {
      analyticsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.handleAnalytics();
      });
    }
  }


  /**
   * Handle reply action
   */
  private async handleReply(): Promise<void> {
    // Check authentication for Write Event
    if (!AuthGuard.requireAuth('reply to this note')) {
      return;
    }

    if (this.config.onReply) {
      this.config.onReply();
    } else {
      // Open ReplyModal with parent note context
      await this.openReplyModal();
    }
  }

  /**
   * Open Reply Modal
   */
  private async openReplyModal(): Promise<void> {
    const { ReplyModal } = await import('../reply/ReplyModal');
    // Pass originalEvent if available (avoids cache lookup/relay fetch = instant!)
    ReplyModal.getInstance().show(this.config.noteId, this.config.originalEvent);
  }

  /**
   * Handle analytics action
   */
  private handleAnalytics(): void {
    if (this.config.onAnalytics) {
      this.config.onAnalytics();
    } else {
      console.log('📊 View analytics for note:', this.config.noteId);
    }
  }

  /**
   * Get current stats
   */
  public getCurrentStats(): ISLStats {
    return { ...this.stats };
  }

  /**
   * Update stats
   */
  public updateStats(stats: Partial<ISLStats>): void {
    this.stats = { ...this.stats, ...stats };

    const repliesCount = this.element.querySelector('.isl-reply .isl-count');
    const repostsCount = this.element.querySelector('.isl-repost .isl-count');
    const quotedRepostsCount = this.element.querySelector('.isl-quote .isl-count');
    const likesCount = this.element.querySelector('.isl-like .isl-count');
    const zapsCount = this.element.querySelector('.isl-zap .isl-count');

    if (repliesCount && stats.replies !== undefined) {
      repliesCount.textContent = formatCount(stats.replies);
    }
    if (repostsCount && stats.reposts !== undefined) {
      repostsCount.textContent = formatCount(stats.reposts);
    }
    if (quotedRepostsCount && stats.quotedReposts !== undefined) {
      quotedRepostsCount.textContent = formatCount(stats.quotedReposts);
    }
    if (likesCount && stats.likes !== undefined) {
      likesCount.textContent = formatCount(stats.likes);
    }
    if (zapsCount && stats.zaps !== undefined) {
      zapsCount.textContent = formatCount(stats.zaps);
    }
  }

  /**
   * Wait for initial stats fetch to complete (if fetchStats was enabled)
   * Used by SNV to wait before overriding stats with accurate local counts
   */
  public async waitForInitialFetch(): Promise<void> {
    if (this.initialFetchPromise) {
      await this.initialFetchPromise;
    }
  }

  /**
   * Get DOM element
   */
  public getElement(): HTMLElement {
    return this.element;
  }

  /**
   * Destroy component
   */
  public destroy(): void {
    // Cleanup managers
    if (this.likeManager) {
      this.likeManager.destroy();
      this.likeManager = null;
    }
    if (this.zapManager) {
      this.zapManager = null;
    }
    if (this.repostManager) {
      this.repostManager = null;
    }
    this.element.remove();
  }
}
