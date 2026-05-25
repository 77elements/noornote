/**
 * TextSelectionToolbar — Floating "Post highlight" trigger.
 *
 * Listens for mouse-driven text selection inside `.event-content` (rendered
 * notes) and `.article-view-content` (long-form articles). On mouseup, if
 * the selection is non-empty AND inside one of those regions AND not inside
 * a modal, a small floating button appears at the mouseup position. Clicking
 * it opens PostNoteModal in NIP-84 Highlight mode pre-filled with the
 * selected passage and the source event.
 *
 * Mobile (Capacitor Android, mobile browsers) intentionally skipped:
 * native long-press selection collides with system selection handles.
 */

import { ModuleLoader } from '../../core/ModuleLoader';
import type { PostsModuleApi } from '../../modules/posts/contracts';
import { AuthService } from '../../services/AuthService';
import { ToastService } from '../../services/ToastService';

interface PendingSelection {
  text: string;
  eventId: string;
}

export class TextSelectionToolbar {
  private static instance: TextSelectionToolbar;
  private button: HTMLButtonElement | null = null;
  private pending: PendingSelection | null = null;
  private initialized = false;

  public static getInstance(): TextSelectionToolbar {
    if (!TextSelectionToolbar.instance) {
      TextSelectionToolbar.instance = new TextSelectionToolbar();
    }
    return TextSelectionToolbar.instance;
  }

  public init(): void {
    if (this.initialized) return;
    this.initialized = true;

    // Mobile platforms use long-press + native handles → skip entirely.
    if (document.documentElement.classList.contains('platform--mobile')) {
      return;
    }

    document.addEventListener('mouseup', this.onMouseUp);
    document.addEventListener('selectionchange', this.onSelectionChange);
    document.addEventListener('mousedown', this.onDocumentMouseDown);
  }

  private onMouseUp = (e: MouseEvent): void => {
    // Defer one tick so the selection is finalized after mouseup completes.
    window.setTimeout(() => this.evaluateSelection(e.clientX, e.clientY), 0);
  };

  private onSelectionChange = (): void => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.toString().trim().length === 0) {
      this.hide();
    }
  };

  private onDocumentMouseDown = (e: MouseEvent): void => {
    if (this.button && !this.button.contains(e.target as Node)) {
      this.hide();
    }
  };

  private evaluateSelection(x: number, y: number): void {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      this.hide();
      return;
    }

    const text = sel.toString().trim();
    if (!text) {
      this.hide();
      return;
    }

    if (!AuthService.getInstance().getCurrentUser()) {
      this.hide();
      return;
    }

    const range = sel.getRangeAt(0);
    const startEl = range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
    if (!startEl) {
      this.hide();
      return;
    }

    // Selection must be inside a note body or an article body.
    const region = startEl.closest('.event-content, .article-view-content');
    if (!region) {
      this.hide();
      return;
    }

    // Modals frequently embed quoted notes whose .event-content we render too.
    // Don't offer "Post highlight" inside a modal — composing inside a composer
    // would be a confusing UX.
    if (startEl.closest('.modal')) {
      this.hide();
      return;
    }

    const sourceCard = startEl.closest('[data-event-id]') as HTMLElement | null;
    if (!sourceCard?.dataset.eventId) {
      this.hide();
      return;
    }

    this.pending = { text, eventId: sourceCard.dataset.eventId };
    this.show(x, y);
  }

  private show(x: number, y: number): void {
    if (!this.button) {
      this.button = this.createButton();
      document.body.appendChild(this.button);
    }

    // Offset slightly so the cursor doesn't sit on top of the button.
    this.button.style.left = `${x + 8}px`;
    this.button.style.top = `${y + 8}px`;
    // Direct `style.display` instead of `[hidden]`: `.btn` declares
    // `display: inline-flex` with equal specificity to the UA `[hidden]`
    // rule, so the attribute alone wouldn't take effect.
    this.button.style.display = '';
  }

  private hide(): void {
    if (this.button) this.button.style.display = 'none';
    this.pending = null;
  }

  private createButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn--mini text-selection-toolbar';
    btn.style.display = 'none';
    btn.innerHTML = `<svg width="14" height="14"><use href="#icon-highlight"/></svg><span>Post highlight</span>`;

    // Prevent the click on the button from clearing the selection before we
    // can read it on click.
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.openModal();
    });

    return btn;
  }

  private async openModal(): Promise<void> {
    if (!this.pending) return;

    const postsApi = ModuleLoader.getInstance().getApi<PostsModuleApi>('posts');
    const event = postsApi?.getCachedNote(this.pending.eventId) ?? null;
    if (!event) {
      ToastService.show('Could not resolve source note. Please reload and try again.', 'error');
      this.hide();
      return;
    }

    const selectedText = this.pending.text;

    window.getSelection()?.removeAllRanges();
    this.hide();

    const { PostNoteModal } = await import('../post/PostNoteModal');
    PostNoteModal.getInstance().show({
      highlightSource: { selectedText, event }
    });
  }
}
