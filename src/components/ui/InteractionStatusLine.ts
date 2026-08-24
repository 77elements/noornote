/**
 * InteractionStatusLine (ISL) Component
 * Displays interaction stats and actions for a note: Reply, Repost, Like, Zap
 * Used in both Timeline View and Single Note View
 */

import { ModuleLoader } from '../../core/ModuleLoader';
import type { ReactionsModuleApi } from '../../modules/reactions/contracts';
import { AuthGuard } from '../../services/AuthGuard';
import { AuthService } from '../../services/AuthService';
import { ToastService } from '../../services/ToastService';
import { TypedEventBus } from '../../core/TypedEventBus';
import { isBookmarksEnabled } from '../../addons/bookmarks/index';
import { formatCount } from '../../helpers/formatCount';
import { PlatformService } from '../../services/PlatformService';
import { CustomDropdown } from './CustomDropdown';
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
  authorPubkey?: string; // Optional author pubkey for Hollywood-style logging
  stats?: ISLStats;
  fetchStats?: boolean;
  isLoggedIn?: boolean; // User logged in - enables interactions (default: false)
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
  private _reactionsApi?: ReactionsModuleApi | null;
  private get reactionsApi(): ReactionsModuleApi | null {
    return (this._reactionsApi ??=
      ModuleLoader.getInstance().getApi<ReactionsModuleApi>('reactions'));
  }
  private initialFetchPromise?: Promise<void>;
  private bookmarkSubId?: string;
  private zapManager: ZapManager | null = null;
  private likeManager: LikeManager | null = null;
  private repostManager: RepostManager | null = null;
  // Mobile only: merged Repost+Quote action menu (saves ISL horizontal space).
  private repostMenu: CustomDropdown | null = null;

  constructor(config: ISLConfig) {
    this.config = config;

    // Initialize stats: use provided stats, or check cache (Timeline shows cached SNV stats)
    if (config.stats) {
      this.stats = config.stats;
    } else {
      const cachedStats =
        this.reactionsApi?.getCachedStats(config.noteId) ?? null;
      if (cachedStats) {
        // Convert InteractionStats to ISLStats
        this.stats = {
          replies: cachedStats.replies,
          reposts: cachedStats.reposts,
          quotedReposts: cachedStats.quotedReposts,
          likes: cachedStats.likes,
          zaps: cachedStats.zaps,
        };
      } else {
        this.stats = {
          replies: 0,
          reposts: 0,
          quotedReposts: 0,
          likes: 0,
          zaps: 0,
        };
      }
    }

    // Initialize managers first (before creating element)
    this.initializeManagers();

    this.element = this.createElement();

    // Check interaction states after DOM is ready
    this.checkInteractionStates();

    // Bookmark state (addon-gated): reflect the current public-bookmark status
    // on the icon and keep it in sync when toggled elsewhere (e.g. the note menu).
    if (isBookmarksEnabled()) {
      void this.checkBookmarkState();
      this.bookmarkSubId = TypedEventBus.getInstance().on(
        'bookmark:updated',
        () => {
          void this.checkBookmarkState();
        }
      );
    }

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
        onStatsUpdate: (_amount: number) => {
          setTimeout(() => this.fetchStats(), 2000);
        },
        ...(this.config.articleEventId && {
          articleEventId: this.config.articleEventId,
        }),
        ...(this.config.onZap && { onCustomZap: this.config.onZap }),
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
        ...(this.config.originalEvent && {
          originalEvent: this.config.originalEvent,
        }),
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
        ...(this.config.originalEvent && {
          originalEvent: this.config.originalEvent,
        }),
        ...(this.config.onRepost && { onRepost: this.config.onRepost }),
        ...(this.config.onReply && { onQuote: this.config.onReply }),
      });
    }
  }

  /**
   * Check interaction states (like/repost/zap) after DOM is created
   */
  private checkInteractionStates(): void {
    if (this.zapManager) {
      void this.zapManager.checkZappedStatus();
      void this.zapManager.checkRecipientCanReceiveZaps();
    }
    if (this.likeManager) {
      void this.likeManager.checkLikedStatus();
    }
    if (this.repostManager) {
      void this.repostManager.checkRepostedStatus();
    }
  }

  /**
   * Fetch interaction stats from relays (background task)
   */
  private async fetchStats(): Promise<void> {
    try {
      // ensure() (not the cached getApi) so stats load on public, logged-out
      // note views too — the reactions module activates on login, but reading
      // stats must work without auth. Write actions stay AuthGuard-gated.
      const reactionsApi =
        await ModuleLoader.getInstance().ensure<ReactionsModuleApi>(
          'reactions'
        );
      const stats = await reactionsApi?.getStats(
        this.config.noteId,
        this.config.authorPubkey
      );
      if (!stats) return;
      this.updateStats({
        replies: stats.replies,
        reposts: stats.reposts,
        quotedReposts: stats.quotedReposts,
        likes: stats.likes,
        zaps: stats.zaps,
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
      ? `<button class="isl-action isl-analytics" type="button" data-action="analytics" title="Analytics">
           <span class="isl-icon"><svg width="18" height="18"><use href="#icon-trending-up"/></svg></span>
         </button>`
      : '';

    // Public bookmark toggle (addon-gated). Private bookmarks stay in the note menu.
    const bookmarkHtml = isBookmarksEnabled()
      ? `<button class="isl-action isl-bookmark" type="button" data-action="bookmark" title="Bookmark">
           <span class="isl-icon"><svg width="18" height="18"><use href="#icon-bookmark-24"/></svg></span>
         </button>`
      : '';

    // Mobile: Repost + Quote are merged into one icon that opens a dropdown
    // (see attachRepostMenu). Desktop keeps the two separate pill buttons.
    const isMobile = PlatformService.getInstance().isMobile;
    const repostQuoteHtml = isMobile
      ? ''
      : `
      <button class="isl-action isl-repost" type="button" data-action="repost" title="Repost">
        <span class="isl-icon"><svg width="18" height="18"><use href="#icon-repost"/></svg></span>
        <span class="isl-count">${formatCount(this.stats.reposts)}</span>
      </button>

      <button class="isl-action isl-quote" type="button" data-action="quote" title="Quoted Repost">
        <span class="isl-icon">❝</span>
        <span class="isl-count">${formatCount(this.stats.quotedReposts)}</span>
      </button>
    `;

    container.innerHTML = `
      <button class="isl-action isl-reply" type="button" data-action="reply" title="Reply">
        <span class="isl-icon"><svg width="18" height="18"><use href="#icon-thread-bubble"/></svg></span>
        <span class="isl-count">${formatCount(this.stats.replies)}</span>
      </button>

      <button class="isl-action isl-zap" type="button" data-action="zap" title="Zap">
        <span class="isl-icon"><svg width="18" height="18"><use href="#icon-zap"/></svg></span>
        <span class="isl-count">${formatCount(this.stats.zaps)}</span>
      </button>

      ${repostQuoteHtml}

      <button class="isl-action isl-like" type="button" data-action="like" title="Like">
        <span class="isl-icon">♡</span>
        <span class="isl-count">${formatCount(this.stats.likes)}</span>
      </button>

      ${analyticsHtml}
      ${bookmarkHtml}
    `;

    if (isMobile) {
      this.attachRepostMenu(container);
    }

    this.attachEventListeners(container);

    return container;
  }

  /**
   * Count shown next to a Repost/Quote menu item: " (n)" when there are any,
   * empty otherwise — so items read "Repost" or "Repost (2)".
   */
  private formatMenuCount(count: number): string {
    return count > 0 ? ` (${formatCount(count)})` : '';
  }

  /**
   * Mobile only: build the merged Repost/Quote dropdown and insert it where the
   * separate repost+quote buttons would otherwise sit (before the Like button).
   * The trigger shows just the repost icon; the counts live next to the two
   * menu items ("Repost (n)" / "Quote (n)").
   */
  private attachRepostMenu(container: HTMLElement): void {
    if (!this.repostManager) return;

    this.repostMenu = new CustomDropdown({
      options: [
        {
          value: 'repost',
          label: `Repost<span class="isl-count">${this.formatMenuCount(this.stats.reposts)}</span>`,
        },
        {
          value: 'quote',
          label: `Quote<span class="isl-count">${this.formatMenuCount(this.stats.quotedReposts)}</span>`,
        },
      ],
      selectedValue: '',
      onChange: value => {
        if (!this.repostManager) return;
        if (value === 'repost') {
          void this.repostManager.handleRepost();
        } else if (value === 'quote') {
          void this.repostManager.handleQuote();
        }
      },
      className: 'isl-repost-menu',
    });

    const menuEl = this.repostMenu.getElement();
    const trigger = menuEl.querySelector('.custom-dropdown__trigger');
    if (trigger) {
      trigger.setAttribute('title', 'Repost');
      trigger.innerHTML =
        '<span class="isl-icon"><svg width="18" height="18"><use href="#icon-repost"/></svg></span>';
      // Lets the RepostManager reflect the "already reposted" state on the icon.
      this.repostManager.setButtonElement(trigger as HTMLElement);

      // Open downward by default, upward when near the bottom of the screen.
      // Capture phase runs before CustomDropdown's own toggle handler.
      trigger.addEventListener(
        'click',
        () => {
          const rect = (trigger as HTMLElement).getBoundingClientRect();
          const spaceBelow = window.innerHeight - rect.bottom;
          menuEl.classList.toggle('isl-repost-menu--up', spaceBelow < 140);
        },
        true
      );
    }

    const likeBtn = container.querySelector('.isl-like');
    container.insertBefore(menuEl, likeBtn);
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
    const bookmarkBtn = container.querySelector('[data-action="bookmark"]');

    if (replyBtn) {
      replyBtn.addEventListener('click', e => {
        e.stopPropagation();
        void this.handleReply();
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
      analyticsBtn.addEventListener('click', e => {
        e.stopPropagation();
        this.handleAnalytics();
      });
    }

    if (bookmarkBtn) {
      bookmarkBtn.addEventListener('click', e => {
        e.stopPropagation();
        void this.handleBookmark();
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
    void ReplyModal.getInstance().show(
      this.config.noteId,
      this.config.originalEvent
    );
  }

  /**
   * Handle analytics action
   */
  private handleAnalytics(): void {
    if (this.config.onAnalytics) {
      this.config.onAnalytics();
    } else {
      console.debug('📊 View analytics for note:', this.config.noteId);
    }
  }

  /**
   * Toggle a PUBLIC bookmark for this note. Private bookmarks remain in the note
   * menu — the ISL icon is the quick public toggle only. noteId is already the
   * original note id (reposts resolved upstream), so no re-resolution is needed.
   */
  private async handleBookmark(): Promise<void> {
    if (!AuthGuard.requireAuth('bookmark note')) {
      return;
    }
    const currentUser = AuthService.getInstance().getCurrentUser();
    if (!currentUser) return;

    try {
      const { BookmarkOrchestrator } = await import('../../lists/bookmarks');
      const orch = BookmarkOrchestrator.getInstance();
      const status = orch.isBookmarked(
        this.config.noteId,
        currentUser.pubkey
      );

      if (status.public) {
        await orch.removeBookmark(this.config.noteId, false);
        ToastService.show('Removed from bookmarks', 'success');
      } else {
        await orch.addBookmark(this.config.noteId, false);
        ToastService.show('Added to bookmarks', 'success');
      }

      // Notify the bookmarks list + every other ISL/menu showing this note.
      TypedEventBus.getInstance().emit('bookmark:updated');
    } catch (error) {
      console.error('Failed to toggle bookmark:', error);
      ToastService.show('Failed to update bookmark', 'error');
    }
  }

  /**
   * Reflect the current public-bookmark status on the icon (filled vs outline).
   */
  private async checkBookmarkState(): Promise<void> {
    try {
      const { BookmarkOrchestrator } = await import('../../lists/bookmarks');
      const status = BookmarkOrchestrator.getInstance().isBookmarked(
        this.config.noteId
      );
      const btn = this.element.querySelector('.isl-bookmark');
      if (!btn) return;
      btn.classList.toggle('active', status.public);
      const use = btn.querySelector('use');
      if (use) {
        use.setAttribute(
          'href',
          status.public ? '#icon-bookmark-24-filled' : '#icon-bookmark-24'
        );
      }
    } catch {
      // Bookmarks module unavailable — leave the icon in its default state.
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
    const quotedRepostsCount = this.element.querySelector(
      '.isl-quote .isl-count'
    );
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
    // Mobile: counts live inside the merged Repost/Quote dropdown items.
    if (this.repostMenu) {
      const menuEl = this.repostMenu.getElement();
      const menuRepostCount = menuEl.querySelector(
        '[data-value="repost"] .isl-count'
      );
      const menuQuoteCount = menuEl.querySelector(
        '[data-value="quote"] .isl-count'
      );
      if (menuRepostCount && stats.reposts !== undefined) {
        menuRepostCount.textContent = this.formatMenuCount(stats.reposts);
      }
      if (menuQuoteCount && stats.quotedReposts !== undefined) {
        menuQuoteCount.textContent = this.formatMenuCount(stats.quotedReposts);
      }
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
    // Unsubscribe the bookmark-sync listener
    if (this.bookmarkSubId) {
      TypedEventBus.getInstance().off(this.bookmarkSubId);
    }
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
    if (this.repostMenu) {
      this.repostMenu.destroy();
      this.repostMenu = null;
    }
    this.element.remove();
  }
}
