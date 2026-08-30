/**
 * EpubReaderService
 *
 * Hosts the foliate-js reader engine for the EpubReaderView.
 *
 * Security model (docs/todos/epub-reader.md — "Sicherheit"):
 * EPUB files may contain scripted content. foliate-js renders section XHTML
 * inside an iframe with `sandbox="allow-same-origin allow-scripts"` (paginator.js),
 * which is effectively NO sandbox — scripts from the book would run on the
 * app origin. The defenses here are therefore load-bearing:
 *   1. transformTarget hook: every XHTML/HTML resource is parsed before render,
 *      <script> elements and on* handler attributes are removed, and a strict
 *      CSP meta tag is injected (belt-and-suspenders on runtimes without a
 *      document CSP).
 *   2. Electron CSP: frame-src must include blob: (electron/main/index.js).
 * Verified against https://github.com/johnfactotum/epub-test.
 *
 * foliate-js is dynamically imported here so it lands in its own chunk that is
 * only fetched when the user actually opens a book.
 */

import { diagLog } from './DiagnosticLogger';
import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';
import { extractEpubFileName } from '../helpers/epubDetection';

export interface ReaderProgress {
  fraction: number;
  chapter: string;
  chapterIndex: number;
  chapterCount: number;
  /** Content-based page position (foliate locations — device-independent) */
  page: { current: number; total: number };
}

export interface TocItem {
  label: string;
  href: string;
}

interface StoredPosition {
  cfi: string;
  fraction: number;
  updatedAt: number;
}

/** Minimal shape of the foliate-js View custom element we interact with */
interface FoliateView extends HTMLElement {
  open(book: unknown): Promise<void>;
  /** Initial navigation — open() does NOT display a page by itself (view.js:303) */
  init(opts: { lastLocation?: string; showTextStart?: boolean }): Promise<void>;
  goTo(target: string): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  close(): void;
  book: {
    toc?: { label: unknown; href: string; subitems?: unknown[] }[];
    sections: unknown[];
    transformTarget?: EventTarget;
    metadata?: { title?: string; author?: unknown };
  };
  lastLocation?: { cfi?: string; fraction?: number };
  renderer?: {
    getContents(): { doc: Document; index: number }[];
  };
}

/** Tracks what destroy() must unwind for the currently open book */
interface OpenSession {
  view: FoliateView;
  objectUrl: string;
  onRelocate: EventListener;
  onLoad: EventListener;
  themeObserver: MutationObserver;
}

/** Accessibility: force pure black-on-white or white-on-black rendering */
export type MonoMode = 'off' | 'bw' | 'wb';

const SCRIPT_STRIP_CSP =
  "default-src 'none'; img-src blob: data: https:; style-src 'unsafe-inline' blob: data:; font-src blob: data:; media-src blob:";

export class EpubReaderService {
  private session: OpenSession | null = null;
  private monoMode: MonoMode = 'off';
  /** Navigation is blocked until the resume init() settled — early input
   *  would yank the paginator off the restored CFI anchor */
  private ready = false;

  public isOpen(): boolean {
    return this.session !== null;
  }

  /**
   * Fetch the EPUB, open it in foliate inside `host`, and wire up progress,
   * TOC and theme. Resolves after the book is opened and (when available) the
   * stored reading position was restored.
   */
  public async open(opts: {
    url: string;
    /** Stable key for reading progress (imeta `x` hash, or SHA-256 of the URL) */
    positionKey: string;
    host: HTMLElement;
    onProgress: (progress: ReaderProgress) => void;
    onToc: (items: TocItem[]) => void;
    onBookInfo?: (info: { title?: string }) => void;
  }): Promise<void> {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('EPUB rendering is not supported in this browser');
    }
    this.destroy();

    this.ready = false;
    diagLog('system', 'Opening EPUB', {
      positionKey: opts.positionKey.slice(0, 16),
      urlLength: opts.url.length,
    });

    const response = await fetch(opts.url);
    if (!response.ok) {
      throw new Error(`EPUB download failed (HTTP ${response.status})`);
    }
    const blob = await response.blob();
    // foliate's makeBook inspects file.name for format detection (isCBZ/isFB2) —
    // a bare Blob has no name, so wrap it in a File like foliate's own fetchFile
    const file = new File([blob], extractEpubFileName(opts.url), {
      type: blob.type || 'application/epub+zip',
    });
    const objectUrl = URL.createObjectURL(file);

    const { makeBook } = (await import('foliate-js/view.js')) as unknown as {
      makeBook: (file: File) => Promise<Record<string, unknown>>;
    };

    // foliate-js/view.js has no default export — the element is registered as a
    // side effect of the import. Create it via the custom element name.
    const view = document.createElement('foliate-view') as FoliateView;

    let strippedScripts = 0;
    const book = (await makeBook(file)) as {
      transformTarget?: EventTarget;
    };

    // Security: transform every XHTML/HTML resource before it reaches the iframe.
    // The cleaned document is re-served as text/html (epub.js createURL takes the
    // type from the event detail) — EPUB sections are XHTML, and re-serializing
    // the HTML-normalized tree back as application/xhtml+xml can break strict XML
    // parsing, which leaves the paginator with a null documentElement.
    book.transformTarget?.addEventListener('data', ((
      event: Event & { detail?: { data?: unknown; type?: string } }
    ) => {
      const detail = event.detail;
      if (!detail || typeof detail.data !== 'string') return;
      const type = detail.type ?? '';
      if (!type.includes('html')) return;
      detail.data = this.sanitizeBookHtml(detail.data, () => strippedScripts++);
      detail.type = 'text/html';
    }) as EventListener);

    opts.host.appendChild(view);
    view.classList.add('epub-reader__viewport-host');
    const onRelocate = (e: Event) => {
      const detail = (
        e as CustomEvent<{
          cfi?: string;
          fraction?: number;
          tocItem?: { label?: unknown };
          section?: { current?: number; total?: number };
          location?: { current?: number; total?: number };
        }>
      ).detail;
      if (!detail) return;
      const progress: ReaderProgress = {
        fraction: typeof detail.fraction === 'number' ? detail.fraction : 0,
        chapter: this.tocLabel(detail.tocItem?.label),
        chapterIndex: detail.section?.current ?? 0,
        chapterCount: detail.section?.total ?? 0,
        page: {
          current: (detail.location?.current ?? 0) + 1,
          total: detail.location?.total ?? 0,
        },
      };
      opts.onProgress(progress);
      if (detail.cfi) {
        this.persistPosition(opts.positionKey, detail.cfi, progress.fraction);
      }
    };

    const onLoad = (e: Event) => {
      const doc = (e as CustomEvent<{ doc?: Document }>).detail?.doc;
      if (!doc) return;
      this.injectReaderTheme(doc);
      this.injectMonoMode(doc);
      this.attachTapZones(doc);
    };

    view.addEventListener('relocate', onRelocate);
    view.addEventListener('load', onLoad);

    await view.open(book);

    // Re-theme the open book when the user switches app themes. ThemeService
    // applies `data-theme` on <html>; custom properties do not cross the
    // iframe boundary, so the section docs get literal colors re-injected.
    const themeObserver = new MutationObserver(() =>
      this.applyThemeToSession()
    );

    this.session = { view, objectUrl, onRelocate, onLoad, themeObserver };
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    if (strippedScripts > 0) {
      diagLog('system', 'EPUB contained active content that was removed', {
        count: strippedScripts,
      });
    }

    // TOC for the header dropdown + book metadata for the header title
    opts.onToc(this.flattenToc(view.book.toc ?? []));
    const bookTitle = (view.book.metadata?.title as string) || undefined;
    if (bookTitle) opts.onBookInfo?.({ title: bookTitle });

    // Initial navigation + resume: init() displays the first page (or the
    // stored CFI when present). open() alone never renders.
    const stored = this.readPositions()[opts.positionKey];
    if (stored?.cfi) {
      diagLog('system', 'Resuming EPUB at saved position', {
        fraction: Math.round((stored.fraction ?? 0) * 100),
      });
    }
    await view.init({
      ...(stored?.cfi ? { lastLocation: stored.cfi } : {}),
      showTextStart: true,
    });
    this.ready = true;
  }

  public next(): Promise<void> {
    if (!this.ready) return Promise.resolve();
    return this.session?.view.next() ?? Promise.resolve();
  }

  public prev(): Promise<void> {
    if (!this.ready) return Promise.resolve();
    return this.session?.view.prev() ?? Promise.resolve();
  }

  public goToHref(href: string): Promise<void> {
    return this.session?.view.goTo(href) ?? Promise.resolve();
  }

  public currentFraction(): number {
    return this.session?.view.lastLocation?.fraction ?? 0;
  }

  /** Fully unwind the current session (idempotent) */
  public destroy(): void {
    this.ready = false;
    const session = this.session;
    if (!session) return;
    this.session = null;
    session.themeObserver.disconnect();
    session.view.removeEventListener('relocate', session.onRelocate);
    session.view.removeEventListener('load', session.onLoad);
    try {
      session.view.close();
    } catch {
      /* already torn down */
    }
    session.view.remove();
    URL.revokeObjectURL(session.objectUrl);
  }

  /**
   * Remove active content from a book resource before rendering:
   * <script> elements, on* handler attributes, existing CSP metas, and inject
   * our own strict CSP meta as defense in depth.
   */
  private sanitizeBookHtml(html: string, onStripped: () => void): string {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');

      for (const script of Array.from(doc.querySelectorAll('script'))) {
        script.remove();
        onStripped();
      }
      // A book-supplied CSP could whitelist scripts / break our theme injection
      for (const meta of Array.from(
        doc.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]')
      )) {
        meta.remove();
      }
      for (const el of Array.from(doc.querySelectorAll('*'))) {
        for (const attr of Array.from(el.attributes)) {
          if (attr.name.toLowerCase().startsWith('on')) {
            el.removeAttribute(attr.name);
            onStripped();
          }
        }
      }

      const csp = doc.createElement('meta');
      csp.setAttribute('http-equiv', 'Content-Security-Policy');
      csp.setAttribute('content', SCRIPT_STRIP_CSP);
      doc.head?.prepend(csp);

      return `<!DOCTYPE html>${doc.documentElement.outerHTML}`;
    } catch {
      // If parsing fails, fall back to a crude script-tag strip — never render
      // unmodified book HTML.
      onStripped();
      return html.replace(/<script[\s\S]*?<\/script>/gi, '');
    }
  }

  /**
   * Resolve the app palette to literal color values. CSS custom properties do
   * not cross the iframe boundary, so `var(--color-1)` inside a book section
   * would always hit the fallback — the colors must be baked in as literals.
   */
  private getResolvedPalette(): Record<string, string> {
    const style = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string): string =>
      style.getPropertyValue(name).trim() || fallback;
    return {
      bg: read('--color-1', '#0f0d23'),
      surface: read('--color-2', '#252343'),
      text: read('--color-5', '#ede2da'),
      accent: read('--color-4', '#dc85ad'),
      selection: read('--color-3', '#9b79b9'),
    };
  }

  private buildReaderCss(p: Record<string, string>): string {
    // Light themes (bright bg) need color-scheme light for native elements
    const bg = (p.bg ?? '').replace('#', '');
    const isLight =
      bg.length >= 6 &&
      (() => {
        const r = parseInt(bg.slice(0, 2), 16) / 255;
        const g = parseInt(bg.slice(2, 4), 16) / 255;
        const b = parseInt(bg.slice(4, 6), 16) / 255;
        return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5;
      })();
    return `
      :root { color-scheme: ${isLight ? 'light' : 'dark'}; --theme-bg-color: ${p.bg}; }
      html { background: ${p.bg} !important; }
      body {
        background: ${p.bg} !important;
        color: ${p.text} !important;
        font-family: inherit;
        line-height: 1.6;
      }
      p { margin: 0 0 0.8em; }
      img, svg, video { max-width: 100%; height: auto; }
      a { color: ${p.accent}; }
      ::selection { background: ${p.selection}; }
    `;
  }

  /** Upsert the theme <style> in every currently-rendered section document */
  private applyThemeToSession(): void {
    const css = this.buildReaderCss(this.getResolvedPalette());
    const contents = this.session?.view.renderer?.getContents() ?? [];
    for (const { doc } of contents) {
      let style = doc.querySelector<HTMLStyleElement>(
        'style[data-noornote-reader]'
      );
      if (!style) {
        style = doc.createElement('style');
        style.setAttribute('data-noornote-reader', '1');
        doc.head?.appendChild(style);
      }
      style.textContent = css;
    }
  }

  /**
   * Accessibility: force pure monochrome rendering. Black-on-white or
   * white-on-black — overrides both the theme palette and any colors the book
   * itself sets (title pages may contain black AND white text on arbitrary
   * backgrounds). Images are grayscaled, not inverted.
   */
  public setMonoMode(mode: MonoMode): void {
    this.monoMode = mode;
    const contents = this.session?.view.renderer?.getContents() ?? [];
    for (const { doc } of contents) this.injectMonoMode(doc);
  }

  public getMonoMode(): MonoMode {
    return this.monoMode;
  }

  private buildMonoCss(mode: MonoMode): string {
    if (mode === 'off') return '';
    const fg = mode === 'bw' ? '#000000' : '#ffffff';
    const bg = mode === 'bw' ? '#ffffff' : '#000000';
    // Specificity matters: the theme style uses `body { … !important }`, so a
    // bare `*` selector would LOSE against it. `body` / `body *` match or beat
    // it, and the mono style tag is appended after the theme tag (same-origin
    // cascade → later wins on ties).
    return `
      body, body * {
        color: ${fg} !important;
        text-shadow: none !important;
      }
      body * {
        border-color: ${fg} !important;
        box-shadow: none !important;
      }
      *, html, body { background-color: transparent !important; }
      html, body { background-color: ${bg} !important; }
      img, svg, video, picture { filter: grayscale(1); }
      ::selection { background: ${fg}; color: ${bg}; }
    `;
  }

  private injectMonoMode(doc: Document): void {
    let style = doc.querySelector<HTMLStyleElement>(
      'style[data-noornote-reader-mono]'
    );
    if (!style) {
      style = doc.createElement('style');
      style.setAttribute('data-noornote-reader-mono', '1');
      doc.head?.appendChild(style);
    }
    style.textContent = this.buildMonoCss(this.monoMode);
  }

  /** Map the app palette onto the book document (theme-reactive reading) */
  private injectReaderTheme(doc: Document): void {
    const css = this.buildReaderCss(this.getResolvedPalette());
    const style = doc.createElement('style');
    style.setAttribute('data-noornote-reader', '1');
    style.textContent = css;
    doc.head?.appendChild(style);
  }

  /**
   * Mouse/tap zones inside the book document: click the left 30% to go back,
   * the right 30% to go forward (the middle stays free for text selection).
   * Links inside the book are handled by foliate itself and excluded here.
   * Re-attached on every section load (each section is a fresh document).
   */
  private attachTapZones(doc: Document): void {
    doc.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('a')) return;
      const selection = doc.getSelection();
      if (selection && !selection.isCollapsed) return;

      // The paginator lays the book out as one huge multi-column canvas inside
      // an oversized iframe (thousands of px) and scrolls it under a clipped
      // container. Zone math must therefore map the click into the VISIBLE
      // window: iframe click x − visible-left-edge (in iframe coords), divided
      // by the container's width. The container lives in the closed shadow
      // root, but tree traversal from frameElement is unaffected by that.
      let visibleLeft = 0;
      let visibleWidth = doc.defaultView?.innerWidth ?? 0;
      const frameEl = doc.defaultView?.frameElement as HTMLElement | null;
      if (frameEl) {
        const container =
          frameEl.closest('#container') ?? frameEl.parentElement;
        if (container) {
          const cRect = container.getBoundingClientRect();
          const fRect = frameEl.getBoundingClientRect();
          visibleLeft = cRect.left - fRect.left;
          visibleWidth = cRect.width;
        }
      }
      if (!visibleWidth) return;

      const x = (e.clientX - visibleLeft) / visibleWidth;
      if (x < 0.3) void this.prev();
      else if (x > 0.7) void this.next();
    });
  }

  private flattenToc(
    items: { label: unknown; href: string; subitems?: unknown[] }[],
    depth = 0
  ): TocItem[] {
    const out: TocItem[] = [];
    for (const item of items) {
      out.push({ label: this.tocLabel(item.label, depth), href: item.href });
      if (item.subitems?.length) {
        out.push(
          ...this.flattenToc(
            item.subitems as typeof items,
            Math.min(depth + 1, 4)
          )
        );
      }
    }
    return out;
  }

  private tocLabel(label: unknown, depth = 0): string {
    const text =
      typeof label === 'string'
        ? label
        : typeof (label as { title?: string })?.title === 'string'
          ? (label as { title: string }).title
          : '';
    const indent = depth > 0 ? '\u00A0\u00A0'.repeat(depth) : '';
    return indent + text;
  }

  private readPositions(): Record<string, StoredPosition> {
    return PerAccountLocalStorage.getInstance().get<
      Record<string, StoredPosition>
    >(StorageKeys.EPUB_READER_POSITIONS, {});
  }

  private persistPosition(
    hashOrUrl: string,
    cfi: string,
    fraction: number
  ): void {
    try {
      const positions = this.readPositions();
      positions[hashOrUrl] = { cfi, fraction, updatedAt: Date.now() };
      // Cap the map so it never grows unboundedly (keep the 50 most recent)
      const entries = Object.entries(positions)
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
        .slice(0, 50);
      PerAccountLocalStorage.getInstance().set(
        StorageKeys.EPUB_READER_POSITIONS,
        Object.fromEntries(entries)
      );
    } catch (err) {
      console.debug('Failed to persist EPUB reading position:', err);
    }
  }
}

/**
 * Compute a stable position key for books without an imeta `x` hash:
 * SHA-256 of the URL, hex-encoded. Returns the raw URL as fallback when
 * Web Crypto is unavailable.
 */
export async function epubPositionKey(
  url: string,
  hash?: string
): Promise<string> {
  if (hash) return hash;
  try {
    const data = new TextEncoder().encode(url);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return url;
  }
}
