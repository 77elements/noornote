/**
 * NIP88PollRenderer - Renders poll options for kind:1068 (NIP-88) poll events
 * Displays poll options with vote counts and allows voting
 *
 * Cross-view sync: After voting, all poll containers with matching pollEventId
 * are updated across all views (TV, SNV, PV) via EventBus
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { PollData } from '../../poll/PollCreator';
import { PollOrchestrator } from '../../../services/orchestration/PollOrchestrator';
import { PollVoteService } from '../../../services/PollVoteService';
import { AuthService } from '../../../services/AuthService';
import { SystemLogger } from '../../../services/SystemLogger';
import { EventBus } from '../../../services/EventBus';
import { RelayConfig } from '../../../services/RelayConfig';
import { escapeHtml } from '../../../helpers/escapeHtml';
import { isImageUrl } from '../../../helpers/extractMedia';

// Store pollData by eventId for cross-view updates
const pollDataCache = new Map<string, PollData>();

export class NIP88PollRenderer {
  private static eventBus = EventBus.getInstance();
  private static listenerSetup = false;

  /**
   * Setup global listener for poll:voted events (once)
   */
  private static setupGlobalListener(): void {
    if (this.listenerSetup) return;
    this.listenerSetup = true;

    this.eventBus.on('poll:voted', (data: { pollEventId: string; results: any }) => {
      this.updateAllPollContainers(data.pollEventId, data.results);
    });
  }

  /**
   * Update all poll containers with matching pollEventId across all views
   */
  private static updateAllPollContainers(pollEventId: string, results: any): void {
    const pollData = pollDataCache.get(pollEventId);
    if (!pollData) return;

    // Find all poll containers for this poll
    const containers = document.querySelectorAll(
      `.nip88-poll[data-poll-event-id="${pollEventId}"]`
    );

    containers.forEach(container => {
      this.updatePollResults(container as HTMLElement, results, pollData);
    });
  }

  /**
   * Render NIP-88 poll (kind:1068)
   * Takes pollData extracted by PollProcessor
   * Fetches and displays vote counts from kind:1018 responses
   */
  static async render(noteElement: HTMLElement, pollData: PollData, event: NostrEvent): Promise<void> {
    if (!pollData || pollData.options.length === 0) return;
    if (!event.id) return; // Skip if event has no ID

    // Capture eventId after the guard to ensure it's a string (for closures)
    const eventId = event.id;

    // Setup global listener for cross-view updates
    this.setupGlobalListener();

    // Cache pollData for cross-view updates
    pollDataCache.set(eventId, pollData);

    // Get services
    const pollOrchestrator = PollOrchestrator.getInstance();
    const authService = AuthService.getInstance();
    const systemLogger = SystemLogger.getInstance();

    // Get current user
    const currentUser = authService.getCurrentUser();

    // Check if poll is expired
    const now = Date.now();
    const isExpired = pollData.endDate ? (pollData.endDate * 1000) < now : false;

    // Create poll container
    const pollContainer = document.createElement('div');
    pollContainer.className = 'nip88-poll';
    pollContainer.dataset.pollEventId = eventId; // Store for cross-view updates

    // Add poll metadata (multiple choice, end date)
    if (pollData.multipleChoice || pollData.endDate) {
      const metaDiv = document.createElement('div');
      metaDiv.className = 'nip88-poll__meta';

      if (pollData.multipleChoice) {
        const multiLabel = document.createElement('span');
        multiLabel.className = 'nip88-poll__meta-item';
        multiLabel.textContent = 'Multiple choice allowed';
        metaDiv.appendChild(multiLabel);
      }

      if (pollData.endDate) {
        const endLabel = document.createElement('span');
        endLabel.className = 'nip88-poll__meta-item';
        const endDate = new Date(pollData.endDate * 1000);

        endLabel.textContent = isExpired
          ? `Ended ${endDate.toLocaleDateString()}`
          : `Ends ${endDate.toLocaleDateString()}`;

        if (isExpired) {
          endLabel.classList.add('nip88-poll__meta-item--expired');
        }

        metaDiv.appendChild(endLabel);
      }

      pollContainer.appendChild(metaDiv);
    }

    // Create options container
    const optionsDiv = document.createElement('div');
    optionsDiv.className = 'nip88-poll__options';

    // Render options with placeholder data initially
    pollData.options.forEach(option => {
      const optionBtn = document.createElement('button');
      optionBtn.className = 'nip88-poll__option';
      optionBtn.dataset.optionId = option.id;
      optionBtn.innerHTML = `
        <span class="nip88-poll__option-label">${this.renderOptionLabel(option.label)}</span>
        <span class="nip88-poll__option-stats">
          <span class="nip88-poll__option-count">0 votes</span>
          <span class="nip88-poll__option-percentage">0%</span>
        </span>
        <span class="nip88-poll__option-bar" style="width: 0%"></span>
      `;

      // Disable if poll expired or user not logged in
      if (isExpired || !currentUser) {
        optionBtn.disabled = true;
      } else {
        // Add vote handler
        optionBtn.addEventListener('click', async () => {
          await this.handleVote(
            eventId,
            option.id,
            pollData,
            pollContainer
          );
        });
      }

      optionsDiv.appendChild(optionBtn);
    });

    pollContainer.appendChild(optionsDiv);

    // Add voter count footer
    const footerDiv = document.createElement('div');
    footerDiv.className = 'nip88-poll__footer';
    footerDiv.textContent = '';
    pollContainer.appendChild(footerDiv);

    // Insert poll container INSIDE event-content, at the END
    // This ensures it appears after the text content but before media/quoted notes
    const contentDiv = noteElement.querySelector('.event-content');

    if (contentDiv) {
      // Wrap existing content in a .poll-question div for targeted styling
      const pollQuestionDiv = document.createElement('div');
      pollQuestionDiv.className = 'poll-question';

      // Move all existing content into the wrapper
      while (contentDiv.firstChild) {
        pollQuestionDiv.appendChild(contentDiv.firstChild);
      }

      // Append wrapper and poll to content div
      contentDiv.appendChild(pollQuestionDiv);
      contentDiv.appendChild(pollContainer);
    } else {
      // Fallback: insert before ISL
      const isl = noteElement.querySelector('.isl');
      if (isl) {
        isl.before(pollContainer);
      } else {
        noteElement.appendChild(pollContainer);
      }
    }

    // Fetch and display vote counts
    try {
      const results = await pollOrchestrator.fetchPollResults(
        eventId,
        pollData.options,
        currentUser?.pubkey
      );

      this.updatePollResults(pollContainer, results, pollData);
    } catch (error) {
      systemLogger.error('NIP88PollRenderer', `Failed to fetch poll results: ${error}`);
    }
  }

  /**
   * Handle vote button click
   */
  private static async handleVote(
    pollEventId: string,
    optionId: string,
    pollData: PollData,
    _pollContainer: HTMLElement
  ): Promise<void> {
    const voteService = PollVoteService.getInstance();
    const pollOrchestrator = PollOrchestrator.getInstance();
    const authService = AuthService.getInstance();
    const systemLogger = SystemLogger.getInstance();

    const currentUser = authService.getCurrentUser();
    if (!currentUser) return;

    // Combine poll's relay tags with aggregator relays for better reach
    const relayConfig = RelayConfig.getInstance();
    const aggregatorRelays = relayConfig.getAggregatorRelays();
    const pollRelays = pollData.relayUrls || [];
    const relays = [...new Set([...pollRelays, ...aggregatorRelays])];

    // Cast vote
    const success = await voteService.castVote({
      pollEventId,
      optionIds: [optionId], // For now, single choice only
      relays
    });

    if (success) {
      // Clear cache and refetch results
      pollOrchestrator.clearCache(pollEventId);

      try {
        const results = await pollOrchestrator.fetchPollResults(
          pollEventId,
          pollData.options,
          currentUser.pubkey
        );

        // Emit event to update ALL poll containers across all views
        this.eventBus.emit('poll:voted', { pollEventId, results });
      } catch (error) {
        systemLogger.error('NIP88PollRenderer', `Failed to refresh poll results: ${error}`);
      }
    }
  }

  /**
   * Update poll UI with vote counts
   */
  private static updatePollResults(
    pollContainer: HTMLElement,
    results: any,
    pollData: PollData
  ): void {
    const totalVoters = results.totalVotes; // Unique voter count

    pollData.options.forEach(option => {
      const optionBtn = pollContainer.querySelector(
        `.nip88-poll__option[data-option-id="${option.id}"]`
      ) as HTMLElement;

      if (!optionBtn) return;

      const resultOption = results.options.find((o: any) => o.id === option.id);
      const voteCount = resultOption?.voteCount || 0;
      const percentage = totalVoters > 0 ? Math.round((voteCount / totalVoters) * 100) : 0;

      // Update stats
      const countSpan = optionBtn.querySelector('.nip88-poll__option-count');
      const percentageSpan = optionBtn.querySelector('.nip88-poll__option-percentage');
      const barSpan = optionBtn.querySelector('.nip88-poll__option-bar') as HTMLElement;

      if (countSpan) {
        countSpan.textContent = `${voteCount} vote${voteCount !== 1 ? 's' : ''}`;
      }

      if (percentageSpan) {
        percentageSpan.textContent = `${percentage}%`;
      }

      if (barSpan) {
        barSpan.style.width = `${percentage}%`;
      }

      // Highlight if user voted for this option
      if (results.userVote === option.id) {
        optionBtn.classList.add('nip88-poll__option--voted');
      } else {
        optionBtn.classList.remove('nip88-poll__option--voted');
      }
    });

    // Update footer with unique voter count
    const footer = pollContainer.querySelector('.nip88-poll__footer');
    if (footer && totalVoters > 0) {
      footer.textContent = `${totalVoters} voter${totalVoters !== 1 ? 's' : ''}`;
    }
  }


  /**
   * Render option label - as image if it's an image URL, otherwise as text
   */
  private static renderOptionLabel(label: string): string {
    if (isImageUrl(label)) {
      return `<img src="${escapeHtml(label)}" alt="Poll option" class="nip88-poll__option-image" loading="lazy">`;
    }
    return escapeHtml(label);
  }
}
