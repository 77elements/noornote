/**
 * Portfolio block — paginated grid of projects, each with click-to-expand
 * screenshot carousel.
 *
 * Editable: per-project sub-card with title / link / description / N
 * screenshot URL rows (URL input + thumbnail + delete + upload). The
 * NospressView event delegation handles persistence — same dispatch as
 * gallery + image blocks.
 *
 * Readonly: emits a wrapper with grid + pagination markup. Card click,
 * expand-collapse animation, page navigation, scroll-snap carousel
 * dot-update — all wired by `portfolioMount.ts` after innerHTML.
 *
 * Heroes are `screenshots[0]`; the editor will surface a reorder UI per
 * shot so the user can pick any image as hero by moving it to position 0.
 */

import { escapeHtml, escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { sanitizeUserHtml } from '../../../../helpers/sanitizeUserHtml';
import { sanitizeUrl } from '../../../../helpers/sanitizeUrl';
import { wrapEditable } from './blockEditWrapper';
import { styleWrap } from '../styles';
import type { Block, PortfolioProject, PortfolioSortOrder } from '../types';

const DEFAULT_PER_PAGE = 12;

/** Format an ISO date (`YYYY-MM` or `YYYY-MM-DD`) for human display.
 *  Falls back to the raw string when the format is unrecognised so the
 *  user always sees what they typed (even if it's not strictly ISO). */
function formatProjectDate(raw: string | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  // YYYY-MM-DD
  const ymd = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) {
    const d = new Date(`${ymd[1]}-${ymd[2]}-${ymd[3]}T00:00:00`);
    if (!isNaN(d.getTime())) {
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    }
  }
  // YYYY-MM
  const ym = trimmed.match(/^(\d{4})-(\d{2})$/);
  if (ym) {
    const d = new Date(`${ym[1]}-${ym[2]}-01T00:00:00`);
    if (!isNaN(d.getTime())) {
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
    }
  }
  return trimmed;
}

/** Sort projects according to the block's `sortOrder`. `manual` preserves
 *  the editor's drag-order; `newest` / `oldest` go by ISO date. Projects
 *  without a date sink to the end in both date modes so the user's
 *  curated head-of-list stays visible. */
function sortProjects(projects: PortfolioProject[], order: PortfolioSortOrder): PortfolioProject[] {
  if (order === 'manual') return projects;
  const dated = projects.filter(p => p.date?.trim());
  const undated = projects.filter(p => !p.date?.trim());
  // ISO strings compare correctly with `<` / `>` — `2024-03` < `2024-03-15`
  // < `2024-04` etc. — so no Date parsing needed for the sort.
  dated.sort((a, b) => {
    const da = (a.date ?? '');
    const db = (b.date ?? '');
    return order === 'newest' ? db.localeCompare(da) : da.localeCompare(db);
  });
  return [...dated, ...undated];
}

export function renderPortfolio(block: Extract<Block, { type: 'portfolio' }>, editable = false): string {
  if (editable) return renderPortfolioEditable(block);
  return renderPortfolioReadonly(block);
}

// ──────────────────────────────────────────────────────────────────────────
// Editable
// ──────────────────────────────────────────────────────────────────────────

function renderPortfolioEditable(block: Extract<Block, { type: 'portfolio' }>): string {
  const perPage = block.perPage ?? DEFAULT_PER_PAGE;
  const sortOrder: PortfolioSortOrder = block.sortOrder ?? 'manual';
  const projectsHtml = block.projects.map((p, idx) => renderEditableProject(block.id, p, idx)).join('');
  const sortOptions = JSON.stringify([
    { value: 'manual', label: 'Manual (drag order)' },
    { value: 'newest', label: 'Newest first' },
    { value: 'oldest', label: 'Oldest first' },
  ]);
  const inner = `
    <div class="nospress-block-portfolio__edit">
      <div class="form__row">
        <label>Items per page</label>
        <input type="number" class="input"
               data-block-id="${block.id}" data-field="portfolio-per-page"
               value="${perPage}" min="1" max="100" />
      </div>
      <div class="form__row">
        <label>Sort by date</label>
        <div data-block-dropdown="portfolio-sort"
             data-block-id="${block.id}"
             data-current-value="${escapeHtmlAttr(sortOrder)}"
             data-options="${escapeHtmlAttr(sortOptions)}"></div>
      </div>
      <div class="nospress-block-portfolio__projects" data-portfolio-projects>
        ${projectsHtml}
      </div>
      <button type="button" class="btn btn--passive"
              data-block-id="${block.id}" data-action="portfolio-add-project">
        + Add project
      </button>
    </div>
  `;
  return wrapEditable(block.id, 'portfolio', inner);
}

function renderEditableProject(blockId: string, project: PortfolioProject, projectIdx: number): string {
  const shotsHtml = project.screenshots.map((url, i) => `
    <div class="nospress-block-portfolio__shot-row" data-shot-index="${i}">
      <input type="url" class="input"
             data-block-id="${blockId}" data-project-id="${project.id}" data-field="portfolio-shot"
             data-shot-index="${i}"
             value="${escapeHtmlAttr(url)}" placeholder="https://…" />
      ${url ? `<img class="nospress-block-portfolio__shot-thumb" src="${escapeHtmlAttr(url)}" alt="" />` : ''}
      <button type="button" class="nospress-block-edit__btn"
              data-block-id="${blockId}" data-project-id="${project.id}" data-shot-index="${i}"
              data-action="portfolio-shot-up" title="Move up" aria-label="Move up"
              ${i === 0 ? 'disabled' : ''}>
        <svg width="14" height="14"><use href="#icon-chevron-up"/></svg>
      </button>
      <button type="button" class="nospress-block-edit__btn"
              data-block-id="${blockId}" data-project-id="${project.id}" data-shot-index="${i}"
              data-action="portfolio-shot-down" title="Move down" aria-label="Move down"
              ${i === project.screenshots.length - 1 ? 'disabled' : ''}>
        <svg width="14" height="14"><use href="#icon-chevron-down"/></svg>
      </button>
      <button type="button" class="nospress-block-edit__btn nospress-block-edit__btn--danger"
              data-block-id="${blockId}" data-project-id="${project.id}" data-shot-index="${i}"
              data-action="portfolio-shot-delete" title="Remove" aria-label="Remove">
        <svg width="14" height="14"><use href="#icon-close"/></svg>
      </button>
    </div>
  `).join('');

  const titlePreview = project.title.trim() || 'Untitled project';
  return `
    <div class="nospress-block-portfolio__project" data-portfolio-project data-project-id="${project.id}">
      <div class="nospress-block-portfolio__project-header">
        <button type="button" class="nospress-block-portfolio__project-toggle"
                data-portfolio-project-toggle
                data-block-id="${blockId}" data-project-id="${project.id}"
                aria-expanded="false">
          <svg class="nospress-block-portfolio__project-caret" width="14" height="14"><use href="#icon-chevron-down"/></svg>
          <span class="nospress-block-portfolio__project-index">#${projectIdx + 1}</span>
          <span class="nospress-block-portfolio__project-title-preview">${escapeHtml(titlePreview)}</span>
        </button>
        <div class="nospress-block-portfolio__project-actions">
          <button type="button" class="nospress-block-edit__btn"
                  data-block-id="${blockId}" data-project-id="${project.id}"
                  data-action="portfolio-project-up" title="Move up" aria-label="Move up"
                  ${projectIdx === 0 ? 'disabled' : ''}>
            <svg width="14" height="14"><use href="#icon-chevron-up"/></svg>
          </button>
          <button type="button" class="nospress-block-edit__btn"
                  data-block-id="${blockId}" data-project-id="${project.id}"
                  data-action="portfolio-project-down" title="Move down" aria-label="Move down">
            <svg width="14" height="14"><use href="#icon-chevron-down"/></svg>
          </button>
          <button type="button" class="nospress-block-edit__btn nospress-block-edit__btn--danger"
                  data-block-id="${blockId}" data-project-id="${project.id}"
                  data-action="portfolio-project-delete" title="Remove" aria-label="Remove">
            <svg width="14" height="14"><use href="#icon-close"/></svg>
          </button>
        </div>
      </div>
      <div class="nospress-block-portfolio__project-body">
        <div class="form__row">
          <label>Title</label>
          <input type="text" class="input"
                 data-block-id="${blockId}" data-project-id="${project.id}" data-field="portfolio-title"
                 value="${escapeHtmlAttr(project.title)}" placeholder="Project title" />
        </div>
        <div class="form__row">
          <label>Link (optional)</label>
          <input type="url" class="input"
                 data-block-id="${blockId}" data-project-id="${project.id}" data-field="portfolio-link"
                 value="${escapeHtmlAttr(project.link ?? '')}" placeholder="https://…" />
        </div>
        <div class="form__row">
          <label>Date (optional, ISO format)</label>
          <input type="text" class="input"
                 data-block-id="${blockId}" data-project-id="${project.id}" data-field="portfolio-date"
                 value="${escapeHtmlAttr(project.date ?? '')}" placeholder="YYYY-MM-DD or YYYY-MM" />
        </div>
        <div class="form__row">
          <label>Description (optional)</label>
          <textarea class="textarea textarea--small"
                    data-block-id="${blockId}" data-project-id="${project.id}" data-field="portfolio-description"
                    placeholder="Short description shown when the card is expanded.">${escapeHtml(project.description ?? '')}</textarea>
        </div>
        <div class="form__row">
          <label>Screenshots (first one is the hero)</label>
          <div class="nospress-block-portfolio__shots">${shotsHtml}</div>
          <div class="nospress-block-portfolio__shots-actions">
            <button type="button" class="btn-icon"
                    data-block-id="${blockId}" data-project-id="${project.id}"
                    data-action="portfolio-shot-upload" title="Upload images" aria-label="Upload images">
              <svg width="20" height="20"><use href="#icon-upload"/></svg>
            </button>
            <input type="file" accept="image/*" multiple style="display:none"
                   data-block-id="${blockId}" data-project-id="${project.id}"
                   data-portfolio-shot-files />
          </div>
        </div>
      </div>
    </div>
  `;
}

// ──────────────────────────────────────────────────────────────────────────
// Readonly (public + editor preview)
// ──────────────────────────────────────────────────────────────────────────

function renderPortfolioReadonly(block: Extract<Block, { type: 'portfolio' }>): string {
  const perPage = Math.max(1, block.perPage ?? DEFAULT_PER_PAGE);
  const projects = sortProjects(block.projects, block.sortOrder ?? 'manual');
  const total = projects.length;
  const pageCount = Math.max(1, Math.ceil(total / perPage));

  // Cards: render ALL of them with a `data-page` index. The mount script
  // shows / hides them per page via a class on the wrapper — avoids a
  // re-render round-trip on page click.
  const cardsHtml = projects.map((p, i) => renderReadonlyCard(p, Math.floor(i / perPage))).join('');

  // Pagination bar — emitted only when more than one page. Active page
  // is set by the mount script via `aria-current="page"` on the matching
  // button so all SCSS pseudo-classes resolve correctly.
  const paginationHtml = pageCount > 1
    ? `<nav class="nospress-block-portfolio__pagination" aria-label="Portfolio pages" data-portfolio-pagination>
         ${Array.from({ length: pageCount }, (_, i) => `
           <button type="button" class="nospress-block-portfolio__page-btn${i === 0 ? ' is-active' : ''}"
                   data-portfolio-page="${i}" aria-current="${i === 0 ? 'page' : 'false'}">
             ${i + 1}
           </button>
         `).join('')}
         <button type="button" class="nospress-block-portfolio__page-btn nospress-block-portfolio__page-btn--next"
                 data-portfolio-page-next aria-label="Next page">»</button>
       </nav>`
    : '';

  const inner = `
    <div class="nospress-block-portfolio__grid" data-portfolio-grid data-current-page="0">
      ${cardsHtml}
    </div>
    ${paginationHtml}
  `;

  return styleWrap(
    block,
    inner,
    {
      tag: 'div',
      baseClass: 'nospress-block-portfolio',
      extraAttrs: 'data-portfolio-mount',
    },
  );
}

function renderReadonlyCard(project: PortfolioProject, pageIdx: number): string {
  const hero = sanitizeUrl(project.screenshots[0] ?? '');
  const heroHtml = hero
    ? `<img class="nospress-block-portfolio__hero" src="${escapeHtmlAttr(hero)}" alt="${escapeHtmlAttr(project.title)}" loading="lazy" />`
    : `<div class="nospress-block-portfolio__hero nospress-block-portfolio__hero--empty">No image</div>`;

  const shotCount = project.screenshots.length;
  const countBadge = shotCount > 1
    ? `<span class="nospress-block-portfolio__count">${shotCount} screenshots</span>`
    : '';
  const dateLabel = formatProjectDate(project.date);
  const dateHtml = dateLabel
    ? `<span class="nospress-block-portfolio__date">${escapeHtml(dateLabel)}</span>`
    : '';

  // Expanded body — rendered ALWAYS but hidden via SCSS until the
  // wrapper carries `.is-expanded`. Keeps the markup self-contained so
  // the mount script doesn't have to inject HTML on click.
  const carouselHtml = project.screenshots.map((url, i) => {
    const safe = sanitizeUrl(url);
    if (!safe) return '';
    return `<div class="nospress-block-portfolio__slide" data-slide-index="${i}">
      <img class="note-image note-image--clickable" src="${escapeHtmlAttr(safe)}" alt="${escapeHtmlAttr(project.title)} screenshot ${i + 1}" loading="lazy" />
    </div>`;
  }).filter(Boolean).join('');

  const dotsHtml = shotCount > 1
    ? `<div class="nospress-block-portfolio__dots" data-portfolio-dots>
         ${project.screenshots.map((_, i) => `
           <button type="button" class="nospress-block-portfolio__dot${i === 0 ? ' is-active' : ''}"
                   data-dot-index="${i}" aria-label="Screenshot ${i + 1}"></button>
         `).join('')}
       </div>`
    : '';

  const descHtml = project.description?.trim()
    ? `<p class="nospress-block-portfolio__desc">${sanitizeUserHtml(project.description)}</p>`
    : '';

  const safeLink = sanitizeUrl(project.link ?? '');
  const linkHtml = safeLink
    ? `<a class="btn btn--passive btn--mini" href="${escapeHtmlAttr(safeLink)}" target="_blank" rel="noopener noreferrer">Visit website ↗</a>`
    : '';

  return `
    <article class="nospress-block-portfolio__card" data-portfolio-card data-project-id="${project.id}" data-page="${pageIdx}">
      <button type="button" class="nospress-block-portfolio__card-trigger" data-portfolio-card-toggle aria-expanded="false">
        ${heroHtml}
        <div class="nospress-block-portfolio__card-meta">
          <h3 class="nospress-block-portfolio__title">${escapeHtml(project.title || 'Untitled project')}</h3>
          ${dateHtml}
          ${countBadge}
        </div>
      </button>
      <div class="nospress-block-portfolio__expanded" data-portfolio-expanded hidden>
        <button type="button" class="nospress-block-portfolio__close" data-portfolio-card-close aria-label="Close">×</button>
        <div class="nospress-block-portfolio__carousel" data-portfolio-carousel>
          ${carouselHtml}
        </div>
        ${dotsHtml}
        ${descHtml ? `<div class="nospress-block-portfolio__body">${descHtml}${linkHtml}</div>` : (linkHtml ? `<div class="nospress-block-portfolio__body">${linkHtml}</div>` : '')}
      </div>
    </article>
  `;
}
