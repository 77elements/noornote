/**
 * Mount step for portfolio blocks. Wires the runtime interactions that
 * can't be pure CSS:
 *
 *   - Card click  → expand the picked card to span the grid's full row
 *                   width (`is-expanded`). Collapses any previously-open
 *                   card on the same grid. Click on hero a second time
 *                   (or the × close button) collapses.
 *   - Carousel    → CSS scroll-snap drives the swipe; this script only
 *                   updates the active-dot indicator on scroll + lets
 *                   the dots click to scroll-into-view.
 *   - Pagination  → toggles a `data-current-page` attr on the grid;
 *                   SCSS hides cards whose `data-page` doesn't match.
 *
 * The mounter delegates clicks at the block-wrapper level (single
 * `addEventListener` per portfolio instance) so re-renders inside the
 * editor don't accumulate handlers.
 *
 * Used by:
 *   - NospressView (editor preview)
 *   - PublicNospressPage (live render)
 */

const MOUNTED_FLAG = 'portfolioMounted';

export function mountNospressPortfolios(container: HTMLElement): void {
  const wrappers = container.querySelectorAll<HTMLElement>('[data-portfolio-mount]');
  wrappers.forEach(wrapper => {
    if (wrapper.dataset[MOUNTED_FLAG] === '1') return;
    wrapper.dataset[MOUNTED_FLAG] = '1';
    wireWrapper(wrapper);
  });
}

function wireWrapper(wrapper: HTMLElement): void {
  const grid = wrapper.querySelector<HTMLElement>('[data-portfolio-grid]');
  if (!grid) return;
  const pagination = wrapper.querySelector<HTMLElement>('[data-portfolio-pagination]');

  // ── Card toggle (expand / collapse) ────────────────────────────────────
  wrapper.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // Close button takes priority — clicked inside an expanded card.
    const closeBtn = target.closest<HTMLElement>('[data-portfolio-card-close]');
    if (closeBtn) {
      const card = closeBtn.closest<HTMLElement>('[data-portfolio-card]');
      if (card) collapseCard(card);
      return;
    }

    // Card trigger (hero + title button) OR meta row — both toggle expand.
    // Meta is rendered as a sibling div so the "Visit website" link can be
    // a real `<a>` (nested `<a>` in `<button>` is HTML-invalid). Clicks on
    // the link itself fall through to the browser's default navigation.
    const trigger = target.closest<HTMLElement>('[data-portfolio-card-toggle], [data-portfolio-card-meta]');
    if (trigger) {
      // Let the visit-website link follow naturally.
      if (target.closest('a')) return;
      // Don't expand when the user clicked an actual image to open the
      // lightbox — the inviolable media-click rule.
      if (target.tagName === 'IMG' && target.classList.contains('note-image--clickable')) return;
      const card = trigger.closest<HTMLElement>('[data-portfolio-card]');
      if (!card) return;
      const wasExpanded = card.classList.contains('is-expanded');
      // Collapse any other open card in this grid (only one open at a time).
      grid.querySelectorAll<HTMLElement>('[data-portfolio-card].is-expanded').forEach(c => {
        if (c !== card) collapseCard(c);
      });
      if (wasExpanded) collapseCard(card);
      else expandCard(card);
      return;
    }

    // Dot click — scroll the carousel to that slide.
    const dot = target.closest<HTMLElement>('[data-dot-index]');
    if (dot) {
      const idx = parseInt(dot.dataset.dotIndex ?? '0', 10);
      const card = dot.closest<HTMLElement>('[data-portfolio-card]');
      const carousel = card?.querySelector<HTMLElement>('[data-portfolio-carousel]');
      const slide = carousel?.querySelector<HTMLElement>(`[data-slide-index="${idx}"]`);
      if (carousel && slide) {
        carousel.scrollTo({ left: slide.offsetLeft - carousel.offsetLeft, behavior: 'smooth' });
      }
      return;
    }
  });

  // ── Pagination ─────────────────────────────────────────────────────────
  if (pagination) {
    pagination.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const next = target.closest<HTMLElement>('[data-portfolio-page-next]');
      if (next) {
        const pages = pagination.querySelectorAll<HTMLElement>('[data-portfolio-page]');
        const current = parseInt(grid.dataset.currentPage ?? '0', 10);
        const last = pages.length - 1;
        const nextIdx = Math.min(last, current + 1);
        setPage(grid, pagination, nextIdx);
        return;
      }
      const pageBtn = target.closest<HTMLElement>('[data-portfolio-page]');
      if (pageBtn) {
        const idx = parseInt(pageBtn.dataset.portfolioPage ?? '0', 10);
        setPage(grid, pagination, idx);
      }
    });
  }
}

function expandCard(card: HTMLElement): void {
  card.classList.add('is-expanded');
  const trigger = card.querySelector<HTMLElement>('[data-portfolio-card-toggle]');
  trigger?.setAttribute('aria-expanded', 'true');
  const expanded = card.querySelector<HTMLElement>('[data-portfolio-expanded]');
  if (expanded) expanded.hidden = false;

  // Wire dot-update on scroll — only after expand so we don't observe
  // hidden carousels.
  const carousel = card.querySelector<HTMLElement>('[data-portfolio-carousel]');
  const dotsHost = card.querySelector<HTMLElement>('[data-portfolio-dots]');
  if (carousel && dotsHost && !carousel.dataset.scrollWired) {
    carousel.dataset.scrollWired = '1';
    carousel.addEventListener('scroll', () => {
      const slides = Array.from(carousel.querySelectorAll<HTMLElement>('[data-slide-index]'));
      // Active slide = the one whose left edge is closest to the
      // carousel's scrollLeft. Cheap, no IntersectionObserver needed.
      let activeIdx = 0;
      let minDelta = Infinity;
      slides.forEach((s, i) => {
        const delta = Math.abs(s.offsetLeft - carousel.offsetLeft - carousel.scrollLeft);
        if (delta < minDelta) {
          minDelta = delta;
          activeIdx = i;
        }
      });
      dotsHost.querySelectorAll<HTMLElement>('[data-dot-index]').forEach((d, i) => {
        d.classList.toggle('is-active', i === activeIdx);
      });
    }, { passive: true });
  }

  // Scroll the card itself into the viewport so the user immediately
  // sees the carousel without manual scrolling. `nearest` keeps the
  // top edge anchored when the card was already on-screen.
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function collapseCard(card: HTMLElement): void {
  card.classList.remove('is-expanded');
  const trigger = card.querySelector<HTMLElement>('[data-portfolio-card-toggle]');
  trigger?.setAttribute('aria-expanded', 'false');
  const expanded = card.querySelector<HTMLElement>('[data-portfolio-expanded]');
  if (expanded) expanded.hidden = true;
}

function setPage(grid: HTMLElement, pagination: HTMLElement, idx: number): void {
  grid.dataset.currentPage = String(idx);
  // Collapse any open card before flipping the page so the next page
  // starts with all cards collapsed.
  grid.querySelectorAll<HTMLElement>('[data-portfolio-card].is-expanded').forEach(collapseCard);
  // Update active button state — both `is-active` class and `aria-current`
  // so styling + accessibility stay in sync.
  pagination.querySelectorAll<HTMLElement>('[data-portfolio-page]').forEach(btn => {
    const i = parseInt(btn.dataset.portfolioPage ?? '0', 10);
    const active = i === idx;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-current', active ? 'page' : 'false');
  });
}
