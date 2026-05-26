/**
 * PollRenderer - Renders poll options for kind:6969 poll events
 * Fetches vote counts via PollOrchestrator and displays results
 * Extracts from: OriginalNoteRenderer.renderPollOptions()
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { ModuleLoader } from '../../../core/ModuleLoader';
import type { SingleNoteModuleApi } from '../../../modules/single-note/contracts';

interface LocalPollOption {
  id: string;
  label: string;
  voteCount: number;
}

export class PollRenderer {
  /**
   * Render poll options for kind 6969 poll events
   * Fetches vote counts via PollOrchestrator and displays results
   */
  static render(noteElement: HTMLElement, event: NostrEvent): void {
    const eventId = event.id;
    if (!eventId) return;

    // Extract poll options from tags
    const pollOptions: LocalPollOption[] = event.tags
      .filter(tag => tag[0] === 'poll_option' && tag[1] !== undefined && tag[2] !== undefined)
      .map(tag => ({ id: tag[1] as string, label: tag[2] as string, voteCount: 0 }))
      .sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));

    if (pollOptions.length === 0) return;

    // Create poll container
    const pollContainer = document.createElement('div');
    pollContainer.className = 'poll-options';

    // Create option buttons (initially without votes)
    pollOptions.forEach(option => {
      const optionBtn = document.createElement('button');
      optionBtn.className = 'poll-option';
      optionBtn.disabled = true;
      optionBtn.dataset.optionIndex = option.id;
      optionBtn.innerHTML = `
        <span class="poll-option-text">${option.label}</span>
        <span class="poll-option-stats">
          <span class="poll-option-count">Loading...</span>
        </span>
      `;
      pollContainer.appendChild(optionBtn);
    });

    // Insert poll container after content, before ISL
    const isl = noteElement.querySelector('.isl');
    if (isl) {
      isl.before(pollContainer);
    } else {
      noteElement.appendChild(pollContainer);
    }

    // Fetch poll results asynchronously
    const singleNoteApi = ModuleLoader.getInstance().getApi<SingleNoteModuleApi>('single-note');
    (singleNoteApi?.fetchPollResults(eventId, pollOptions) ?? Promise.reject('Module not loaded')).then(results => {
        // Update UI with vote counts
        results.options.forEach((option: { id: string; voteCount: number }) => {
          const optionBtn = pollContainer.querySelector(`[data-option-index="${option.id}"]`);
          if (!(optionBtn instanceof HTMLElement)) return;

          const countSpan = optionBtn.querySelector('.poll-option-count');
          if (!countSpan) return;

          // Calculate percentage
          const percentage = results.totalVotes > 0
            ? Math.round((option.voteCount / results.totalVotes) * 100)
            : 0;

          // Update text
          countSpan.textContent = `${percentage}% (${option.voteCount} ${option.voteCount === 1 ? 'vote' : 'votes'})`;

          // Add progress bar background
          optionBtn.style.setProperty('--vote-percentage', `${percentage}%`);
          optionBtn.classList.add('has-votes');
        });
    }).catch(error => {
        console.warn('Failed to fetch poll results:', error);
        // Show error state
        pollOptions.forEach(option => {
          const optionBtn = pollContainer.querySelector(`[data-option-index="${option.id}"]`);
          if (!optionBtn) return;

          const countSpan = optionBtn.querySelector('.poll-option-count');
          if (countSpan) {
            countSpan.textContent = 'Failed to load votes';
          }
        });
    });
  }
}
