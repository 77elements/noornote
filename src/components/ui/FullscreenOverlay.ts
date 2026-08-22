export interface FullscreenOverlayOptions {
  title: string;
  body: HTMLElement;
  exitLabel?: string;
  /** Render the Exit button as a transparent X icon (`#icon-close`)
   *  instead of a labeled pill. `exitLabel` becomes the `aria-label` so
   *  screen readers still get the verbose name. Useful when the header
   *  already carries other pills and a labeled Exit button would crowd
   *  the row. */
  exitAsIcon?: boolean;
  onExit?: () => void;
  closeOnEsc?: boolean;
  maxWidth?: string;
  /** Additional header buttons/links rendered to the LEFT of the Exit
   *  button. Caller owns instantiation, listeners, and lifetime — the
   *  overlay only appends them. Use `<a target="_blank">` for "open in
   *  new tab" actions. */
  extraActions?: HTMLElement[];
}

export class FullscreenOverlay {
  private overlay: HTMLElement | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private readonly title: string;
  private readonly body: HTMLElement;
  private readonly exitLabel: string;
  private readonly exitAsIcon: boolean;
  private readonly onExit: () => void;
  private readonly closeOnEsc: boolean;
  private readonly maxWidth: string;
  private readonly extraActions: HTMLElement[];

  constructor(opts: FullscreenOverlayOptions) {
    this.title = opts.title;
    this.body = opts.body;
    this.exitLabel = opts.exitLabel ?? 'Exit Fullscreen';
    this.exitAsIcon = opts.exitAsIcon ?? false;
    this.onExit = opts.onExit ?? (() => {});
    this.closeOnEsc = opts.closeOnEsc ?? true;
    this.maxWidth = opts.maxWidth ?? '960px';
    this.extraActions = opts.extraActions ?? [];
  }

  public mount(): void {
    if (this.overlay) return;

    const overlay = document.createElement('div');
    overlay.className = 'fullscreen-overlay';

    const inner = document.createElement('div');
    inner.className = 'fullscreen-overlay__inner';
    inner.style.maxWidth = this.maxWidth;

    const header = document.createElement('header');
    header.className = 'fullscreen-overlay__header l-spread';

    const titleEl = document.createElement('h1');
    titleEl.className = 'fullscreen-overlay__title';
    titleEl.textContent = this.title;

    const actions = document.createElement('div');
    actions.className = 'fullscreen-overlay__actions';
    for (const action of this.extraActions) {
      actions.appendChild(action);
    }
    const exitBtn = document.createElement('button');
    exitBtn.type = 'button';
    exitBtn.dataset.fullscreenExit = '';
    if (this.exitAsIcon) {
      exitBtn.className = 'btn btn--square-sm btn--passive';
      exitBtn.setAttribute('aria-label', this.exitLabel);
      exitBtn.title = this.exitLabel;
      exitBtn.textContent = '×';
    } else {
      exitBtn.className = 'btn btn--passive btn--medium';
      exitBtn.textContent = this.exitLabel;
    }
    exitBtn.addEventListener('click', () => this.unmount());
    actions.appendChild(exitBtn);

    header.appendChild(titleEl);
    header.appendChild(actions);

    const bodyWrap = document.createElement('div');
    bodyWrap.className = 'fullscreen-overlay__body';
    bodyWrap.appendChild(this.body);

    inner.appendChild(header);
    inner.appendChild(bodyWrap);
    overlay.appendChild(inner);

    if (this.closeOnEsc) {
      this.keydownHandler = e => {
        if (e.key === 'Escape') {
          e.preventDefault();
          this.unmount();
        }
      };
      document.addEventListener('keydown', this.keydownHandler);
    }

    document.body.appendChild(overlay);
    this.overlay = overlay;
  }

  public unmount(): void {
    if (!this.overlay) return;

    this.onExit();

    if (this.keydownHandler) {
      document.removeEventListener('keydown', this.keydownHandler);
      this.keydownHandler = null;
    }

    this.overlay.remove();
    this.overlay = null;
  }

  public isMounted(): boolean {
    return this.overlay !== null;
  }
}
