/**
 * FollowsExtendedFeatures - Extended features for the Follows list
 *
 * Extracted from FollowListManager to enable addon-ization.
 * Contains: Mutual badges, Zap In/Out stats, Check for changes, Changes modal.
 *
 * This class is instantiated by FollowListManager and called at specific points.
 * It manages its own services and state, but relies on FollowListManager for
 * the items list and container element.
 */

import {
  UserProfileService,
  type UserProfile,
} from '../services/UserProfileService';
import {
  FollowVerificationService,
  type MutualState,
} from '../services/FollowVerificationService';
import { MutualChangeDetector } from '../services/MutualChangeDetector';
import { MutualChangeStorage } from './MutualChangeStorage';
import { ZapStatsService } from '../services/ZapStatsService';
import { TypedEventBus } from '../core/TypedEventBus';
import { ToastService } from '../services/ToastService';
import { ProgressBarHelper } from '../helpers/ProgressBarHelper';
import { extractDisplayName } from '../helpers/extractDisplayName';
import {
  renderUserMention,
  setupUserMentionHandlers,
} from '../helpers/UserMentionHelper';
import { formatTimeAgo } from '../helpers/formatTimeAgo';

export interface FollowItemForExtended {
  pubkey: string;
  /** Canonical tri-state "does this user follow me back?" — see FollowVerificationService. */
  mutualState: MutualState;
  profile?: UserProfile;
}

export class FollowsExtendedFeatures {
  private followVerification: FollowVerificationService;
  private mutualChangeDetector: MutualChangeDetector;
  private mutualChangeStorage: MutualChangeStorage;
  private zapStatsService: ZapStatsService;
  private userProfileService: UserProfileService;
  private eventBus: TypedEventBus;

  // State
  public mutualCount: number = 0;
  public zapStatsLoaded: boolean = false;

  constructor() {
    this.followVerification = FollowVerificationService.getInstance();
    this.mutualChangeDetector = MutualChangeDetector.getInstance();
    this.mutualChangeStorage = MutualChangeStorage.getInstance();
    this.zapStatsService = ZapStatsService.getInstance();
    this.userProfileService = UserProfileService.getInstance();
    this.eventBus = TypedEventBus.getInstance();
  }

  /**
   * Setup TypedEventBus listeners for extended features.
   * Returns subscription IDs for cleanup.
   */
  public setupEventListeners(callbacks: {
    onZapStatsLoaded: () => void;
    onMutualChangesUpdate: () => void;
  }): string[] {
    const ids: string[] = [];

    ids.push(
      this.eventBus.on('zapstats:loaded', () => {
        this.zapStatsLoaded = true;
        callbacks.onZapStatsLoaded();
      })
    );

    ids.push(
      this.eventBus.on('mutual-changes:detected', () => {
        callbacks.onMutualChangesUpdate();
      })
    );

    ids.push(
      this.eventBus.on('mutual-changes:seen', () => {
        callbacks.onMutualChangesUpdate();
      })
    );

    return ids;
  }

  /**
   * Start loading zap stats for all pubkeys (fire-and-forget).
   */
  public startZapStatsLoading(pubkeys: string[]): void {
    this.zapStatsService.loadStatsForPubkeys(pubkeys);
  }

  /**
   * Check mutual status for a batch of items via the canonical
   * FollowVerificationService (throttled, tri-state). Sets `mutualState` on
   * each item and counts the definitive mutuals. 'unknown' stays 'unknown' so
   * it renders as a neutral "checking…" instead of a sticky false negative.
   */
  public async checkMutualStatusBatch(
    batch: FollowItemForExtended[]
  ): Promise<void> {
    if (batch.length === 0) return;
    const pubkeys = batch.map(item => item.pubkey);
    const verdicts = await this.followVerification.verifyFollowsBackBatch(
      pubkeys,
      { concurrency: 5 }
    );
    for (const item of batch) {
      const state = verdicts.get(item.pubkey)?.status ?? 'unknown';
      item.mutualState = state;
      if (state === 'follows') {
        this.mutualCount++;
      }
    }
  }

  /**
   * After a batch renders, re-verify any items still 'unknown' in the
   * background (forceRefresh) and patch their badges + the mutual count once a
   * definitive verdict arrives. Lets the list converge to the correct state
   * within a session instead of waiting for a manual re-render. Safe to call on
   * a detached/closed list: row lookups no-op and isConnected is checked.
   *
   * @param batch        The items that were just rendered.
   * @param container    The list DOM root holding the rendered rows.
   * @param onStatsDirty Called when mutualCount changes, so the caller can
   *                     refresh the stats header.
   */
  public scheduleUnknownReverify(
    batch: FollowItemForExtended[],
    container: HTMLElement,
    onStatsDirty: () => void
  ): void {
    const unknowns = batch.filter(item => item.mutualState === 'unknown');
    if (unknowns.length === 0) return;
    void this.reverifyUnknowns(unknowns, container, onStatsDirty);
  }

  private async reverifyUnknowns(
    unknowns: FollowItemForExtended[],
    container: HTMLElement,
    onStatsDirty: () => void
  ): Promise<void> {
    const verdicts = await this.followVerification.verifyFollowsBackBatch(
      unknowns.map(u => u.pubkey),
      { forceRefresh: true, concurrency: 3 }
    );
    let countChanged = false;
    for (const item of unknowns) {
      const verdict = verdicts.get(item.pubkey);
      // Still unknown — leave the "checking…" badge; it'll retry on next render.
      if (!verdict || verdict.status === 'unknown') continue;
      item.mutualState = verdict.status;
      if (verdict.status === 'follows') {
        this.mutualCount++;
        countChanged = true;
      }
      if (!container.isConnected) return; // list closed mid-reverify
      const row = container.querySelector(
        `.follow-item[data-pubkey="${item.pubkey}"]`
      );
      const badge = row?.querySelector('.mutual-badge');
      if (badge) {
        badge.outerHTML = this.renderMutualBadge(verdict.status);
      }
    }
    if (countChanged && container.isConnected) {
      onStatsDirty();
    }
  }

  // ========== Rendering Helpers ==========

  /**
   * Render the mutual badge HTML for a follow item, tri-state.
   * - 'follows' → green "Mutual"
   * - 'does-not-follow' → purple "Not following back"
   * - 'unknown' → neutral "checking…" (no false negative; re-verified in background)
   */
  public renderMutualBadge(state: MutualState): string {
    switch (state) {
      case 'follows':
        return `<span class="mutual-badge mutual-badge--yes">Mutual</span>`;
      case 'does-not-follow':
        return `<span class="mutual-badge mutual-badge--no">Not following back</span>`;
      default:
        return `<span class="mutual-badge mutual-badge--checking">checking…</span>`;
    }
  }

  /**
   * Render the zap stats badge HTML for a pubkey.
   */
  public renderZapBadge(pubkey: string): string {
    if (!this.zapStatsLoaded) {
      return `<span class="zap-stats-badge zap-stats-badge--loading" data-pubkey="${pubkey}">Zaps: Loading...</span>`;
    }

    const stats = this.zapStatsService.getStats(pubkey);
    if (!stats) {
      return `<span class="zap-stats-badge" data-pubkey="${pubkey}">Zaps: In (0) 0 | Out (0) 0</span>`;
    }

    const inSats = this.zapStatsService.formatSats(stats.incomingSats);
    const outSats = this.zapStatsService.formatSats(stats.outgoingSats);

    return `<span class="zap-stats-badge" data-pubkey="${pubkey}">Zaps: In (${stats.incomingCount}) ${inSats} | Out (${stats.outgoingCount}) ${outSats}</span>`;
  }

  /**
   * Update all zap badges in the DOM after stats are loaded.
   */
  public updateAllZapBadges(containerElement: HTMLElement): void {
    const badges = containerElement.querySelectorAll('.zap-stats-badge');
    badges.forEach(badge => {
      const pubkey = badge.getAttribute('data-pubkey');
      if (!pubkey) return;

      const stats = this.zapStatsService.getStats(pubkey);
      badge.classList.remove('zap-stats-badge--loading');

      if (!stats) {
        badge.textContent = 'Zaps: In (0) 0 | Out (0) 0';
        return;
      }

      const inSats = this.zapStatsService.formatSats(stats.incomingSats);
      const outSats = this.zapStatsService.formatSats(stats.outgoingSats);
      badge.textContent = `Zaps: In (${stats.incomingCount}) ${inSats} | Out (${stats.outgoingCount}) ${outSats}`;
    });
  }

  /**
   * Render the "Check for changes" link HTML.
   */
  public renderCheckForChangesHtml(): string {
    const lastCheckTimestamp = this.mutualChangeStorage.getLastCheckTimestamp();
    const lastCheckText = lastCheckTimestamp
      ? formatTimeAgo(lastCheckTimestamp)
      : 'Never';

    return `
      <div class="follows-check-changes">
        <a href="#" class="follows-check-changes__link">Check for changes</a>
        <span class="follows-check-changes__last-check">Last: ${lastCheckText}</span>
      </div>
    `;
  }

  /**
   * Render the stats header HTML.
   */
  public renderStatsHtml(totalFollowing: number): string {
    const percentage =
      totalFollowing === 0
        ? 0
        : Math.round((this.mutualCount / totalFollowing) * 100);
    return `Following: ${totalFollowing} | Mutuals: <span class="mutual-count">${this.mutualCount}</span> (<span class="mutual-percentage">${percentage}</span>%)`;
  }

  /**
   * Update the stats header in the DOM.
   */
  public updateStatsHeader(
    container: HTMLElement,
    totalFollowing: number
  ): void {
    const statsEl = container.querySelector('.follows-stats');
    if (statsEl) {
      statsEl.innerHTML = this.renderStatsHtml(totalFollowing);
    }
  }

  // ========== Event Handlers ==========

  /**
   * Bind the "Check for changes" click handler.
   */
  public bindCheckForChanges(container: HTMLElement): void {
    const checkLink = container.querySelector('.follows-check-changes__link');
    checkLink?.addEventListener('click', async e => {
      e.preventDefault();
      await this.handleCheckForChanges(container);
    });
  }

  /**
   * Handle "Check for changes" click.
   */
  private async handleCheckForChanges(container: HTMLElement): Promise<void> {
    const checkLink = container.querySelector('.follows-check-changes__link');
    const lastCheckSpan = container.querySelector(
      '.follows-check-changes__last-check'
    );
    const followsHeader = container.querySelector(
      '.follows-header'
    ) as HTMLElement;

    if (checkLink) {
      checkLink.textContent = 'Checking...';
      (checkLink as HTMLElement).style.pointerEvents = 'none';
    }

    const progressBar = followsHeader
      ? new ProgressBarHelper(followsHeader)
      : null;
    progressBar?.start();

    try {
      const result = await this.mutualChangeDetector.detect(
        (checked, total) => {
          if (checkLink) {
            checkLink.textContent = `Checking ${checked} of ${total} follows`;
          }
          if (progressBar) {
            progressBar.update((checked / total) * 100);
          }
        }
      );

      if (lastCheckSpan) {
        lastCheckSpan.textContent = 'Last: Just now';
      }

      if (result.isFirstCheck) {
        ToastService.show(
          'Initial snapshot saved. Changes will be detected on next check.',
          'info'
        );
      } else if (result.totalChanges === 0) {
        ToastService.show('No changes detected', 'success');
      } else {
        this.showChangesModal(container, result);
      }
    } catch (error) {
      console.error('Failed to check for changes:', error);
      ToastService.show('Failed to check for changes', 'error');
    } finally {
      progressBar?.complete();
      if (checkLink) {
        checkLink.textContent = 'Check for changes';
        (checkLink as HTMLElement).style.pointerEvents = '';
      }
    }
  }

  /**
   * Show modal with detected mutual changes.
   */
  private async showChangesModal(
    container: HTMLElement,
    result: { unfollows: string[]; newMutuals: string[]; totalChanges: number }
  ): Promise<void> {
    const modal = container.querySelector(
      '.mutual-changes-modal'
    ) as HTMLElement;
    if (!modal) return;

    const unfollowData = await Promise.all(
      result.unfollows.map(async pubkey => {
        const profile = await this.userProfileService.getUserProfile(pubkey);
        return {
          pubkey,
          username: extractDisplayName(profile),
          avatarUrl: profile?.picture || '',
        };
      })
    );

    const newMutualData = await Promise.all(
      result.newMutuals.map(async pubkey => {
        const profile = await this.userProfileService.getUserProfile(pubkey);
        return {
          pubkey,
          username: extractDisplayName(profile),
          avatarUrl: profile?.picture || '',
        };
      })
    );

    modal.innerHTML = `
      <div class="mutual-changes-modal__backdrop"></div>
      <div class="mutual-changes-modal__content">
        <h3>Mutual Changes Detected</h3>
        <p class="mutual-changes-modal__summary">
          ${result.totalChanges} ${result.totalChanges === 1 ? 'change' : 'changes'} detected
        </p>

        ${
          newMutualData.length > 0
            ? `
          <div class="mutual-changes-modal__section mutual-changes-modal__section--positive">
            <h4>New Mutuals (${newMutualData.length})</h4>
            <ul class="mutual-changes-modal__list">
              ${newMutualData
                .map(
                  data => `
                <li class="mutual-changes-modal__item mutual-changes-modal__item--positive">
                  ${renderUserMention(data.pubkey, { username: data.username, avatarUrl: data.avatarUrl })} started following you back!
                </li>
              `
                )
                .join('')}
            </ul>
          </div>
        `
            : ''
        }

        ${
          unfollowData.length > 0
            ? `
          <div class="mutual-changes-modal__section mutual-changes-modal__section--negative">
            <h4>Unfollows (${unfollowData.length})</h4>
            <ul class="mutual-changes-modal__list">
              ${unfollowData
                .map(
                  data => `
                <li class="mutual-changes-modal__item mutual-changes-modal__item--negative">
                  ${renderUserMention(data.pubkey, { username: data.username, avatarUrl: data.avatarUrl })} stopped following back
                </li>
              `
                )
                .join('')}
            </ul>
          </div>
        `
            : ''
        }

        <div class="mutual-changes-modal__actions">
          <button class="btn btn--primary mutual-changes-modal__mark-seen">Mark as Seen</button>
          <button class="btn btn--passive mutual-changes-modal__close">Close</button>
        </div>
      </div>
    `;

    modal.style.display = 'flex';

    setupUserMentionHandlers(modal);

    const closeModal = (): void => {
      modal.style.display = 'none';
    };

    modal
      .querySelector('.mutual-changes-modal__mark-seen')
      ?.addEventListener('click', async () => {
        await this.mutualChangeDetector.markAsSeen();
        closeModal();
        ToastService.show('Changes marked as seen', 'success');
      });

    modal
      .querySelector('.mutual-changes-modal__close')
      ?.addEventListener('click', closeModal);
    modal
      .querySelector('.mutual-changes-modal__backdrop')
      ?.addEventListener('click', closeModal);
  }

  /**
   * Update green dot indicator in sidebar.
   */
  public updateGreenDot(): void {
    const hasUnseen = this.mutualChangeStorage.hasUnseenChanges();

    const tabButton = document.querySelector('[data-tab="list-follows"]');
    if (tabButton) {
      const existingDot = tabButton.querySelector('.follows-unseen-dot');
      if (hasUnseen && !existingDot) {
        const dot = document.createElement('span');
        dot.className = 'follows-unseen-dot';
        tabButton.appendChild(dot);
      } else if (!hasUnseen && existingDot) {
        existingDot.remove();
      }
    }
  }

  // ========== Sorting ==========

  /**
   * Sort items by zap sum (highest first).
   */
  public sortByZaps(items: FollowItemForExtended[]): void {
    items.sort((a, b) => {
      const statsA = this.zapStatsService.getStats(a.pubkey);
      const statsB = this.zapStatsService.getStats(b.pubkey);

      const sumA = (statsA?.incomingSats || 0) + (statsA?.outgoingSats || 0);
      const sumB = (statsB?.incomingSats || 0) + (statsB?.outgoingSats || 0);

      return sumB - sumA;
    });
  }

  /**
   * Clear unseen mutual changes and update green dot.
   * Called when the follows tab is opened.
   */
  public clearUnseenChanges(): void {
    if (this.mutualChangeStorage.hasUnseenChanges()) {
      this.mutualChangeStorage.setUnseenChanges(false);
      this.updateGreenDot();
    }
  }

  /**
   * Reset state (on user switch / logout).
   */
  public reset(): void {
    this.mutualCount = 0;
    this.zapStatsLoaded = false;
  }
}
