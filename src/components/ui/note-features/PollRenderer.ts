/**
 * PollRenderer - Renders poll options for kind:6969 poll events
 * Fetches vote counts via the single-note module and displays results
 * Extracts from: OriginalNoteRenderer.renderPollOptions()
 *
 * Also hosts the shared poll-UI building blocks (option extraction, option
 * buttons, result application, error state) — QuotedNoteRenderer reuses them
 * for polls inside quotes.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { ModuleLoader } from '../../../core/ModuleLoader';
import { escapeHtml } from '../../../helpers/escapeHtml';
import type { SingleNoteModuleApi } from '../../../modules/single-note/contracts';

export interface LocalPollOption {
  id: string;
  label: string;
  voteCount: number;
}

export class PollRenderer {
  /**
   * Render poll options for kind 6969 poll events
   * Fetches vote counts via the single-note module and displays results
   */
  static render(noteElement: HTMLElement, event: NostrEvent): void {
    const eventId = event.id;
    if (!eventId) return;

    const pollOptions = PollRenderer.extractOptions(event.tags);
    if (pollOptions.length === 0) return;

    const pollContainer = PollRenderer.buildOptionsContainer(pollOptions);

    // Insert poll container after content, before ISL
    const isl = noteElement.querySelector('.isl');
    if (isl) {
      isl.before(pollContainer);
    } else {
      noteElement.appendChild(pollContainer);
    }

    PollRenderer.fetchAndFill(eventId, pollOptions, pollContainer);
  }

  /** Parse + sort poll_option tags, filtering out invalid entries. */
  static extractOptions(tags: string[][]): LocalPollOption[] {
    return tags
      .filter(tag => tag[0] === 'poll_option' && tag[1] && tag[2])
      .map(tag => ({
        id: tag[1] as string,
        label: tag[2] as string,
        voteCount: 0,
      }))
      .sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
  }

  /** Build the disabled-options container (counts show "Loading..."). */
  static buildOptionsContainer(pollOptions: LocalPollOption[]): HTMLElement {
    const pollContainer = document.createElement('div');
    pollContainer.className = 'poll-options';

    pollOptions.forEach(option => {
      const optionBtn = document.createElement('button');
      optionBtn.className = 'poll-option';
      optionBtn.disabled = true;
      optionBtn.dataset.optionIndex = option.id;
      optionBtn.innerHTML = `
        <span class="poll-option-text">${escapeHtml(option.label)}</span>
        <span class="poll-option-stats">
          <span class="poll-option-count">Loading...</span>
        </span>
      `;
      pollContainer.appendChild(optionBtn);
    });

    return pollContainer;
  }

  /** Fetch results via the single-note module and fill the container. */
  static fetchAndFill(
    eventId: string,
    pollOptions: LocalPollOption[],
    pollContainer: HTMLElement
  ): void {
    const singleNoteApi =
      ModuleLoader.getInstance().getApi<SingleNoteModuleApi>('single-note');
    (
      singleNoteApi?.fetchPollResults(eventId, pollOptions) ??
      Promise.reject('Module not loaded')
    )
      .then(results => PollRenderer.applyResults(pollContainer, results))
      .catch(error => {
        console.debug('Failed to fetch poll results:', error);
        PollRenderer.markFailed(pollContainer);
      });
  }

  /** Update option buttons with percentages + progress-bar backgrounds. */
  static applyResults(
    pollContainer: HTMLElement,
    results: {
      totalVotes: number;
      options: { id: string; voteCount: number }[];
    }
  ): void {
    results.options.forEach(option => {
      const optionBtn = pollContainer.querySelector(
        `[data-option-index="${option.id}"]`
      );
      if (!(optionBtn instanceof HTMLElement)) return;

      const countSpan = optionBtn.querySelector('.poll-option-count');
      if (!countSpan) return;

      const percentage =
        results.totalVotes > 0
          ? Math.round((option.voteCount / results.totalVotes) * 100)
          : 0;

      countSpan.textContent = `${percentage}% (${option.voteCount} ${option.voteCount === 1 ? 'vote' : 'votes'})`;

      optionBtn.style.setProperty('--vote-percentage', `${percentage}%`);
      optionBtn.classList.add('has-votes');
    });
  }

  /** Show the per-option error state. */
  static markFailed(pollContainer: HTMLElement): void {
    pollContainer.querySelectorAll('.poll-option-count').forEach(countSpan => {
      countSpan.textContent = 'Failed to load votes';
    });
  }
}
