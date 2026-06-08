/**
 * TimelineUIStateHandler - Manages UI state presentation
 * Handles skeleton loaders, loading indicators, empty states, and error messages
 * Extracts from: TimelineUI UI state methods
 */

import { createNoteSkeleton } from '../../../helpers/createSkeleton';
import { NoteUI } from '../../ui/NoteUI';
import { Router } from '../../../services/Router';

/** Remove note-cards from container, cleaning up NoteUI internals first */
function removeNoteCards(container: HTMLElement): void {
  container.querySelectorAll('.note-card').forEach(card => {
    const eventId = card.getAttribute('data-event-id');
    if (eventId) NoteUI.cleanup(eventId);
    card.remove();
  });
}

export class TimelineUIStateHandler {
  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /**
   * Show skeleton loaders for initial load
   */
  showSkeletonLoaders(count: number = 5): void {
    const loadTrigger = this.container.querySelector('.timeline-load-trigger');
    if (!loadTrigger) return;

    removeNoteCards(this.container);
    // Drop a stale curated-fallback banner so a re-init reflects the real state.
    this.container.querySelector('.timeline-curated-banner')?.remove();

    // Create skeleton loaders
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const skeleton = createNoteSkeleton();
      fragment.appendChild(skeleton);
    }

    // Insert before load trigger
    this.container.insertBefore(fragment, loadTrigger);
  }

  /**
   * Hide skeleton loaders
   */
  hideSkeletonLoaders(): void {
    // Remove all skeletons
    const skeletons = this.container.querySelectorAll('.note-skeleton');
    skeletons.forEach(skeleton => skeleton.remove());
  }

  /**
   * Show/hide "Loading more..." indicator
   */
  showMoreLoading(show: boolean): void {
    const loading = this.container.querySelector('.timeline-loading');
    if (loading) {
      (loading as HTMLElement).style.display = show ? 'block' : 'none';
    }
  }

  /**
   * Show empty state message
   */
  showEmptyState(): void {
    const empty = this.container.querySelector('.timeline-empty');
    if (empty) {
      (empty as HTMLElement).style.display = 'block';
    }
  }

  /**
   * Hide empty state message
   */
  hideEmptyState(): void {
    const empty = this.container.querySelector('.timeline-empty');
    if (empty) {
      (empty as HTMLElement).style.display = 'none';
    }
  }

  /**
   * Show error message
   */
  showError(message: string): void {
    const loadTrigger = this.container.querySelector('.timeline-load-trigger');
    if (loadTrigger) {
      removeNoteCards(this.container);

      // Create error element
      const errorDiv = document.createElement('div');
      errorDiv.className = 'timeline-error';
      errorDiv.innerHTML = `
        <h3>Error</h3>
        <p>${message}</p>
        <button onclick="window.location.reload()">Retry</button>
      `;

      // Insert before load trigger
      this.container.insertBefore(errorDiv, loadTrigger);
    }
  }

  /**
   * Show error state (generic fallback)
   */
  showErrorState(message: string): void {
    this.showError(message);
  }

  /**
   * Friendly banner shown above the curated starter feed when the user follows
   * nobody yet. Pinned to the top of the timeline; persists until the user
   * follows someone and the real feed takes over on the next load.
   */
  showCuratedFallbackBanner(): void {
    this.container.querySelector('.timeline-curated-banner')?.remove();

    const banner = document.createElement('div');
    banner.className = 'timeline-curated-banner';

    const title = document.createElement('p');
    title.className = 'timeline-curated-banner__title';
    title.textContent = "Looks like you're not following anyone yet.";

    const text = document.createElement('p');
    text.className = 'timeline-curated-banner__text';
    text.append('Here are some suggestions to get you started. Just hover your mouse over a profile pic (or tap on it) to follow a user. Find more under Addons → ');

    const link = document.createElement('a');
    link.href = '/addons/follow-packs';
    link.className = 'timeline-curated-banner__link';
    link.textContent = 'Follow Packs';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      Router.getInstance().navigate('/addons/follow-packs');
    });
    text.appendChild(link);
    text.append('.');

    banner.appendChild(title);
    banner.appendChild(text);
    this.container.insertBefore(banner, this.container.firstChild);
  }

  /**
   * Clear all note cards from timeline
   */
  clearNotes(): void {
    removeNoteCards(this.container);
  }
}
