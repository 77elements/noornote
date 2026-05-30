/**
 * MarkdownToolbar - shared rudimentary Markdown formatting toolbar.
 *
 * Extracted from ArticleEditorView so multiple features (Articles, Note taking)
 * share one insert implementation. Operates purely on a caller-provided
 * <textarea>: it edits `textarea.value` + selection directly and dispatches an
 * `input` event, so the host keeps its own state in sync via its existing input
 * listener. Image inserts go through a caller-provided async uploader.
 *
 * Scope is deliberately limited to: heading, bold, italic, quote, image.
 *
 * @component MarkdownToolbar
 * @used-by ArticleEditorView, NoteTakingView
 */

export interface MarkdownToolbarOptions {
  /** Returns the textarea this toolbar operates on (resolved lazily per action). */
  getTextarea: () => HTMLTextAreaElement | null;
  /** Upload an image and return its URL (null = failed/cancelled). */
  onImageUpload?: (file: File) => Promise<string | null>;
}

export class MarkdownToolbar {
  private readonly options: MarkdownToolbarOptions;
  private root: HTMLElement | null = null;

  private readonly onButtonClick = (e: Event): void => {
    const action = (e.currentTarget as HTMLElement).dataset.mdAction || '';
    this.applyAction(action);
  };

  private readonly onFileChange = async (e: Event): Promise<void> => {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (file) {
      await this.handleImageUpload(file);
      target.value = '';
    }
  };

  constructor(options: MarkdownToolbarOptions) {
    this.options = options;
  }

  /**
   * Markup to embed inside a host template. After it's in the DOM, locate the
   * resulting `.md-toolbar` element and pass it to `attach()`.
   */
  public render(): string {
    return `
      <div class="md-toolbar">
        <button type="button" class="btn-icon" data-md-action="heading" title="Heading">
          <svg width="16" height="16"><use href="#icon-heading"/></svg>
        </button>
        <button type="button" class="btn-icon" data-md-action="bold" title="Bold">
          <svg width="16" height="16"><use href="#icon-bold"/></svg>
        </button>
        <button type="button" class="btn-icon" data-md-action="italic" title="Italic">
          <svg width="16" height="16"><use href="#icon-italic"/></svg>
        </button>
        <button type="button" class="btn-icon" data-md-action="quote" title="Quote">
          <svg width="16" height="16"><use href="#icon-quote"/></svg>
        </button>
        <button type="button" class="btn-icon" data-md-action="image" title="Insert Image">
          <svg width="16" height="16"><use href="#icon-image"/></svg>
        </button>
        <input type="file" accept="image/*" class="md-toolbar__file-input" data-md-file-input style="display: none;" />
      </div>
    `;
  }

  /** Wire listeners. Pass the specific `.md-toolbar` element to scope to it. */
  public attach(root: HTMLElement): void {
    this.root = root;
    root.querySelectorAll('[data-md-action]').forEach((btn) =>
      btn.addEventListener('click', this.onButtonClick)
    );
    this.getFileInput()?.addEventListener('change', this.onFileChange);
  }

  /** Remove all listeners and drop references. */
  public destroy(): void {
    if (!this.root) return;
    this.root.querySelectorAll('[data-md-action]').forEach((btn) =>
      btn.removeEventListener('click', this.onButtonClick)
    );
    this.getFileInput()?.removeEventListener('change', this.onFileChange);
    this.root = null;
  }

  private getFileInput(): HTMLInputElement | null {
    return (this.root?.querySelector('[data-md-file-input]') as HTMLInputElement) ?? null;
  }

  private applyAction(action: string): void {
    const textarea = this.options.getTextarea();
    if (!textarea) return;

    if (action === 'image') {
      this.getFileInput()?.click();
      return;
    }

    const value = textarea.value;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = value.slice(start, end);
    const before = value.slice(0, start);
    const after = value.slice(end);

    let insertion = '';
    let cursorOffset = 0;

    switch (action) {
      case 'heading':
        insertion = selectedText ? `## ${selectedText}` : '## ';
        cursorOffset = selectedText ? insertion.length : 3;
        break;
      case 'bold':
        insertion = selectedText ? `**${selectedText}**` : '****';
        cursorOffset = selectedText ? insertion.length : 2;
        break;
      case 'italic':
        insertion = selectedText ? `*${selectedText}*` : '**';
        cursorOffset = selectedText ? insertion.length : 1;
        break;
      case 'quote':
        insertion = selectedText ? `> ${selectedText}` : '> ';
        cursorOffset = insertion.length;
        break;
      default:
        return;
    }

    textarea.value = before + insertion + after;
    const newPos = start + cursorOffset;
    textarea.setSelectionRange(newPos, newPos);
    textarea.focus();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  private async handleImageUpload(file: File): Promise<void> {
    if (!file.type.startsWith('image/') || !this.options.onImageUpload) return;

    const url = await this.options.onImageUpload(file);
    if (!url) return;

    const textarea = this.options.getTextarea();
    if (!textarea) return;

    const value = textarea.value;
    const start = textarea.selectionStart;
    const insertion = `![](${url})\n`;
    textarea.value = value.slice(0, start) + insertion + value.slice(textarea.selectionEnd);

    const newPos = start + insertion.length;
    textarea.setSelectionRange(newPos, newPos);
    textarea.focus();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }
}
