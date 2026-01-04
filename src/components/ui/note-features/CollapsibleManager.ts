/**
 * CollapsibleManager - Manages collapsible notes/quote boxes
 * Uses ResizeObserver to measure actual rendered height (like DevTools Computed)
 * Works for ALL note types without analyzing structure
 */

import { PerAccountLocalStorage, StorageKeys } from '../../../services/PerAccountLocalStorage';
import { EventBus } from '../../../services/EventBus';

export class CollapsibleManager {
  // Collapsible note thresholds (in viewport height units)
  private static readonly COLLAPSIBLE_HEIGHT_THRESHOLD = 0.40; // 40vh - collapse if taller than this
  private static readonly COLLAPSIBLE_MIN_DIFFERENCE = 0.05;   // 5vh - only collapse if difference is significant
  private static initialized = false;

  /**
   * Initialize global event listeners (call once on app start)
   */
  static init(): void {
    if (this.initialized) return;
    this.initialized = true;

    const eventBus = EventBus.getInstance();

    // Listen for post truncation setting changes
    eventBus.on('settings:post-truncation-changed', (data: { disabled: boolean }) => {
      // Update all existing collapsible wrappers
      const wrappers = document.querySelectorAll('.collapsible-wrapper');
      const buttons = document.querySelectorAll('.btn--show-more');

      wrappers.forEach((wrapper, index) => {
        const btn = buttons[index] as HTMLElement;
        if (btn) {
          CollapsibleManager.checkAndCollapse(wrapper as HTMLElement, btn);
        }
      });
    });
  }

  /**
   * Setup collapsible for a note
   * MEASUREMENT-BASED APPROACH: Wait for final layout, measure actual height, apply CSS
   * Works for all note types without type-specific logic
   */
  static setup(noteElement: HTMLElement): void {
    const isQuoteBox = noteElement.classList.contains('quote-box');

    // For quote boxes, work with .quote-content as root
    const workingRoot = isQuoteBox
      ? noteElement.querySelector('.quote-content') as HTMLElement
      : noteElement;

    if (!workingRoot) return;

    // Find ISL if exists (only in note-cards, not in quote-boxes)
    // Use :scope > .isl to only match DIRECT children (not nested ISLs)
    const islEl = isQuoteBox ? null : workingRoot.querySelector(':scope > .isl') as HTMLElement;

    // Create collapsible wrapper
    const collapsibleWrapper = document.createElement('div');
    collapsibleWrapper.className = 'collapsible-wrapper';

    // Move ALL direct children into wrapper EXCEPT ISL
    const childrenToMove = Array.from(workingRoot.children).filter(child => child !== islEl);
    childrenToMove.forEach(child => {
      collapsibleWrapper.appendChild(child);
    });

    // Insert wrapper before ISL (or at end if no ISL)
    if (islEl) {
      workingRoot.insertBefore(collapsibleWrapper, islEl);
    } else {
      workingRoot.appendChild(collapsibleWrapper);
    }

    // Create Show More button
    const showMoreBtn = document.createElement('button');
    showMoreBtn.className = 'btn btn--passive btn--show-more';
    showMoreBtn.setAttribute('data-action', 'show-more');
    showMoreBtn.textContent = 'Show More';
    showMoreBtn.style.display = 'none'; // Hidden by default

    // Insert button before ISL (or at end if no ISL)
    if (islEl) {
      workingRoot.insertBefore(showMoreBtn, islEl);
    } else {
      workingRoot.appendChild(showMoreBtn);
    }

    // Toggle on click
    showMoreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isCollapsed = collapsibleWrapper.classList.contains('is-collapsed');

      if (isCollapsed) {
        collapsibleWrapper.classList.remove('is-collapsed');
        collapsibleWrapper.classList.add('is-expanded');
        showMoreBtn.textContent = 'Show Less';
      } else {
        collapsibleWrapper.classList.add('is-collapsed');
        collapsibleWrapper.classList.remove('is-expanded');
        showMoreBtn.textContent = 'Show More';
      }
    });

    // INTERSECTION OBSERVER: Measure when note scrolls into viewport
    // By then ALL async content (quotes, images, videos) is guaranteed loaded
    // Works for: initial notes, LoadMore notes, notes with quotes, videos, iframes
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          // Note is visible - measure after short delay for final layout
          setTimeout(() => {
            requestAnimationFrame(() => {
              CollapsibleManager.checkAndCollapse(collapsibleWrapper, showMoreBtn);
              observer.disconnect(); // Measure once only
            });
          }, 100);
        }
      });
    }, {
      threshold: 0.01, // Trigger when even 1% visible
      rootMargin: '50px' // Start measuring slightly before entering viewport
    });

    observer.observe(workingRoot);
  }

  /**
   * Check note height and collapse if needed
   * Only collapses if note is significantly taller than threshold
   */
  private static checkAndCollapse(wrapperEl: HTMLElement, btnEl: HTMLElement): void {
    // Check if post truncation is disabled
    const storage = PerAccountLocalStorage.getInstance();
    const isTruncationDisabled = storage.get<boolean>(StorageKeys.DISABLE_POST_TRUNCATION, false);

    if (isTruncationDisabled) {
      // User disabled truncation - always show full content
      btnEl.style.display = 'none';
      wrapperEl.classList.remove('is-collapsed');
      wrapperEl.classList.remove('is-expanded');
      return;
    }

    const viewportHeight = window.innerHeight;
    const contentHeight = wrapperEl.scrollHeight;

    const collapseThreshold = viewportHeight * CollapsibleManager.COLLAPSIBLE_HEIGHT_THRESHOLD;
    const minDifference = viewportHeight * CollapsibleManager.COLLAPSIBLE_MIN_DIFFERENCE;

    // Only show button if content is SIGNIFICANTLY taller than threshold
    // Example: content must be > 45vh to collapse to 40vh (if min difference is 5vh)
    if (contentHeight > collapseThreshold + minDifference) {
      btnEl.style.display = 'block';
      wrapperEl.classList.add('is-collapsed');
      wrapperEl.classList.remove('is-expanded');
      btnEl.textContent = 'Show More';
    } else {
      // Not worth collapsing - show full height
      btnEl.style.display = 'none';
      wrapperEl.classList.remove('is-collapsed');
      wrapperEl.classList.remove('is-expanded');
    }
  }
}
