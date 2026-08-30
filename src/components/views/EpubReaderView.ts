/**
 * EpubReaderView — full-width reader view for EPUB books shared in Nostr notes.
 *
 * Route: /reader/:encodedUrl (URL as encoded path param, decoded by the router
 * paramHandler — same pattern as /relay/:relayUrl).
 *
 * Data Saver: when the Data Saver toggle is ON, the EPUB file is NOT fetched
 * on view mount. A tap-to-load placeholder (same `.media-placeholder` mechanic
 * as images/videos) gates the fetch until the user taps. The download button
 * on the note card stays a direct, user-initiated action either way.
 *
 * Security: the underlying foliate-js engine renders book content in an iframe
 * that permits scripts — EpubReaderService strips active content before render.
 */

import { View } from './View';
import {
  EpubReaderService,
  epubPositionKey,
  type MonoMode,
  type ReaderProgress,
  type TocItem,
} from '../../services/EpubReaderService';
import { isDataSaverEnabled } from '../../services/DataSaverService';
import { PlatformService } from '../../services/PlatformService';
import { ErrorService } from '../../services/ErrorService';
import { SystemLogger } from '../../services/SystemLogger';
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../services/PerAccountLocalStorage';
import { CustomDropdown, type DropdownOption } from '../ui/CustomDropdown';
import { addSwipeSupport } from '../../helpers/addSwipeSupport';
import { extractEpubFileName } from '../../helpers/epubDetection';

const TOC_MAX_ENTRIES = 500;

/** Footer navigation hint — platform-appropriate input methods */
const NAV_HINT_DESKTOP = 'Navigate with ← / → or click the page edges';
const NAV_HINT_MOBILE = 'Tap the page edges or swipe to turn pages';

/** Accessibility mono-mode cycle: theme colors → black on white → white on black */
const MONO_CYCLE: MonoMode[] = ['off', 'bw', 'wb'];

const MONO_LABELS: Record<MonoMode, string> = {
  off: 'Theme colors',
  bw: 'Monochrome: black on white',
  wb: 'Monochrome: white on black',
};

export class EpubReaderView extends View {
  private container: HTMLElement;
  private viewport: HTMLElement;
  private progressLabel: HTMLElement;
  private navHint: HTMLElement;
  private titleEl: HTMLElement;
  private tocHost: HTMLElement;
  private dropdown: CustomDropdown | null = null;
  private monoButton: HTMLButtonElement | null = null;
  private monoMode: MonoMode = 'off';
  private readonly service = new EpubReaderService();
  private readonly url: string;
  private readonly fileName: string;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private loadStarted = false;
  private destroyed = false;

  constructor(url: string) {
    super();
    this.url = url;
    this.fileName = extractEpubFileName(url);

    this.container = document.createElement('div');
    this.container.className =
      'view-content view-content--epub-reader epub-reader';

    const header = document.createElement('header');
    header.className = 'epub-reader__header';
    const left = document.createElement('div');
    left.className = 'epub-reader__header-left';
    const back = document.createElement('button');
    back.className = 'btn btn--medium btn--passive';
    back.textContent = '← Back';
    back.addEventListener('click', () => history.back());
    left.appendChild(back);
    // Center: book title from EPUB metadata (falls back to the file name)
    this.titleEl = document.createElement('span');
    this.titleEl.className = 'epub-reader__title';
    this.titleEl.textContent = this.fileName;
    this.tocHost = document.createElement('div');
    this.tocHost.className = 'epub-reader__toc-host';
    this.tocHost.appendChild(this.createMonoButton());
    header.appendChild(left);
    header.appendChild(this.titleEl);
    header.appendChild(this.tocHost);

    this.viewport = document.createElement('div');
    this.viewport.className = 'epub-reader__viewport';

    const footer = document.createElement('div');
    footer.className = 'epub-reader__footer';
    this.navHint = document.createElement('div');
    this.navHint.className = 'epub-reader__hint';
    this.navHint.textContent = PlatformService.getInstance().isAndroid
      ? NAV_HINT_MOBILE
      : NAV_HINT_DESKTOP;
    this.progressLabel = document.createElement('div');
    this.progressLabel.className = 'epub-reader__progress';
    footer.appendChild(this.navHint);
    footer.appendChild(this.progressLabel);

    this.container.appendChild(header);
    this.container.appendChild(this.viewport);
    this.container.appendChild(footer);

    this.keyHandler = (e: KeyboardEvent) => this.handleKey(e);
    document.addEventListener('keydown', this.keyHandler);

    addSwipeSupport(
      this.viewport,
      () => void this.service.next(),
      () => void this.service.prev()
    );

    void this.start();
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.destroyed = true;
    if (this.keyHandler) {
      document.removeEventListener('keydown', this.keyHandler);
      this.keyHandler = null;
    }
    this.dropdown?.destroy();
    this.dropdown = null;
    this.service.destroy();
    this.viewport.innerHTML = '';
    this.container.innerHTML = '';
  }

  public override pause(): void {
    if (this.keyHandler) {
      document.removeEventListener('keydown', this.keyHandler);
      this.keyHandler = null;
    }
  }

  public override resume(): void {
    if (!this.keyHandler && !this.destroyed) {
      this.keyHandler = (e: KeyboardEvent) => this.handleKey(e);
      document.addEventListener('keydown', this.keyHandler);
    }
  }

  private handleKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowRight') void this.service.next();
    else if (e.key === 'ArrowLeft') void this.service.prev();
  }

  /**
   * Monochrome accessibility toggle: round icon button left of the TOC
   * dropdown, cycling theme colors → black on white → white on black. The
   * choice persists per account (accessibility preference, not per book).
   */
  private createMonoButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'btn-icon epub-reader__mono-btn';
    btn.type = 'button';
    btn.innerHTML =
      '<svg width="18" height="18" aria-hidden="true"><use href="#icon-contrast"/></svg>';
    btn.addEventListener('click', () => this.cycleMonoMode());
    this.monoButton = btn;
    return btn;
  }

  private cycleMonoMode(): void {
    const idx = MONO_CYCLE.indexOf(this.monoMode);
    this.setMonoMode(MONO_CYCLE[(idx + 1) % MONO_CYCLE.length] ?? 'off');
  }

  private setMonoMode(mode: MonoMode): void {
    this.monoMode = mode;
    this.service.setMonoMode(mode);
    if (this.monoButton) {
      this.monoButton.setAttribute('aria-label', MONO_LABELS[mode]);
      this.monoButton.title = MONO_LABELS[mode];
    }
    PerAccountLocalStorage.getInstance().set(
      StorageKeys.EPUB_READER_MONO_MODE,
      mode
    );
  }

  private applyStoredMonoMode(): void {
    const stored = PerAccountLocalStorage.getInstance().get<MonoMode | null>(
      StorageKeys.EPUB_READER_MONO_MODE,
      null
    );
    const mode: MonoMode =
      stored && MONO_CYCLE.includes(stored) ? stored : 'off';
    this.setMonoMode(mode);
  }

  /** Data Saver gates the fetch; otherwise load right away. */
  private async start(): Promise<void> {
    const positionKey = await epubPositionKey(this.url);
    if (this.destroyed) return;

    if (isDataSaverEnabled()) {
      this.renderTapToLoad(() => void this.loadBook(positionKey));
    } else {
      void this.loadBook(positionKey);
    }
  }

  private renderTapToLoad(onTap: () => void): void {
    this.viewport.innerHTML = '';
    const placeholder = document.createElement('div');
    placeholder.className = 'media-placeholder media-placeholder--epub';
    placeholder.setAttribute('role', 'button');
    placeholder.tabIndex = 0;
    const icon = document.createElement('span');
    icon.className = 'media-placeholder__icon';
    icon.innerHTML =
      '<svg width="18" height="18" aria-hidden="true"><use href="#icon-book-open"/></svg>';
    const label = document.createElement('span');
    label.className = 'media-placeholder__label';
    label.textContent = 'Data Saver is on — tap to load book';
    placeholder.appendChild(icon);
    placeholder.appendChild(label);
    placeholder.addEventListener('click', onTap);
    placeholder.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onTap();
      }
    });
    this.viewport.appendChild(placeholder);
  }

  private async loadBook(positionKey: string): Promise<void> {
    if (this.loadStarted || this.destroyed) return;
    this.loadStarted = true;

    this.viewport.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'epub-reader__loading pulsate';
    loading.textContent = 'Loading book…';
    this.viewport.appendChild(loading);

    try {
      await this.service.open({
        url: this.url,
        positionKey,
        host: this.viewport,
        onProgress: p => this.updateProgress(p),
        onToc: items => this.buildTocDropdown(items),
        onBookInfo: info => {
          // EPUB metadata title (falls back to the file name)
          if (info.title) {
            this.titleEl.textContent = info.title;
          }
        },
      });
      loading.remove();
      this.applyStoredMonoMode();
      SystemLogger.getInstance().success(
        'Reader',
        `Book ready — ${this.fileName}`
      );
    } catch (err) {
      if (this.destroyed) return;
      ErrorService.handle(err, 'EpubReaderView.loadBook', true);
      SystemLogger.getInstance().error('Reader', 'Could not load this book');
      this.viewport.innerHTML = '';
      const error = document.createElement('div');
      error.className = 'epub-reader__error';
      error.textContent =
        'This book could not be loaded. You can try the download button on the original post.';
      this.viewport.appendChild(error);
    }
  }

  private updateProgress(progress: ReaderProgress): void {
    const percent = Math.round(progress.fraction * 100);
    const parts: string[] = [];
    if (progress.page.total > 0) {
      parts.push(`Page ${progress.page.current} / ${progress.page.total}`);
    }
    parts.push(`${percent}%`);
    if (progress.chapter) parts.push(progress.chapter);
    else if (progress.chapterCount > 0) {
      parts.push(
        `Chapter ${progress.chapterIndex + 1}/${progress.chapterCount}`
      );
    }
    this.progressLabel.textContent = parts.join(' · ');
  }

  private buildTocDropdown(items: TocItem[]): void {
    if (this.destroyed || items.length === 0) return;
    const capped = items.slice(0, TOC_MAX_ENTRIES);
    const options: DropdownOption[] = capped.map((item, i) => ({
      value: String(i),
      label: item.label || `Section ${i + 1}`,
    }));
    this.dropdown = new CustomDropdown({
      options,
      selectedValue: '',
      searchable: true,
      className: 'epub-reader__toc',
      onChange: value => {
        const item = capped[Number(value)];
        if (item) void this.service.goToHref(item.href);
      },
    });
    this.tocHost.appendChild(this.dropdown.getElement());
  }
}
