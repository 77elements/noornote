import { escapeHtml } from '../../helpers/escapeHtml';

export interface FullscreenOverlayOptions {
  title: string;
  body: HTMLElement;
  exitLabel?: string;
  onExit?: () => void;
  closeOnEsc?: boolean;
  maxWidth?: string;
}

export class FullscreenOverlay {
  private overlay: HTMLElement | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private readonly title: string;
  private readonly body: HTMLElement;
  private readonly exitLabel: string;
  private readonly onExit: () => void;
  private readonly closeOnEsc: boolean;
  private readonly maxWidth: string;

  constructor(opts: FullscreenOverlayOptions) {
    this.title = opts.title;
    this.body = opts.body;
    this.exitLabel = opts.exitLabel ?? 'Exit Fullscreen';
    this.onExit = opts.onExit ?? (() => {});
    this.closeOnEsc = opts.closeOnEsc ?? true;
    this.maxWidth = opts.maxWidth ?? '960px';
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
    header.innerHTML = `
      <h1 class="fullscreen-overlay__title">${escapeHtml(this.title)}</h1>
      <button class="btn btn--passive btn--medium" data-fullscreen-exit>${escapeHtml(this.exitLabel)}</button>
    `;
    header.querySelector('[data-fullscreen-exit]')?.addEventListener('click', () => this.unmount());

    const bodyWrap = document.createElement('div');
    bodyWrap.className = 'fullscreen-overlay__body';
    bodyWrap.appendChild(this.body);

    inner.appendChild(header);
    inner.appendChild(bodyWrap);
    overlay.appendChild(inner);

    if (this.closeOnEsc) {
      this.keydownHandler = (e) => {
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
