/**
 * Property panel renderer — the Right-pane "Properties" tab body.
 *
 * Pipeline:
 *   `renderPropertyPanel(opts)`
 *     → `renderMobileMenuSubScopePanel` (when scope is `nav-menu-mobile…`)
 *     → `renderPanelInternal` (regular path)
 *         → `renderEntriesForGroups` (group → entries → rows)
 *         → identifiers + extras + sub-scope sections (links / nav-menu
 *           desktop / bookmark-folder / articles-list) appended below
 *
 * The renderer composes single-property rows, paired rows (CSS-grid
 * `.nospress-prop-pair`), quad inputs, dropdown slots, divider picker,
 * text-shadow group (split into two paired rows), and color/background
 * rows (delegated to `renderColorPickerRow`).
 */

import { escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { readStyleField } from '../styles/access';
import {
  ARTICLES_LIST_GROUPS,
  BOOKMARK_FOLDER_GROUPS,
  LINK_SUBSCOPE_GROUPS,
  MOBILE_MENU_SECTIONS,
  NAV_MENU_DESKTOP_GROUPS,
  PORTFOLIO_GROUPS,
  WEBLOG_GROUPS,
  getDefaultDisplayFor,
  groupedSchemaFor,
  matrixKey,
  resolveGroupEntries,
} from '../styles/catalog';
import { DIVIDER_STYLE_OPTIONS, dividerThumbSvg } from '../styles/divider';
import {
  ARTICLES_LIST_KEYS,
  BLOCKS_WITH_LINKS_SUBSCOPE,
  BOOKMARK_FOLDER_KEYS,
  LINK_PSEUDO_KEYS,
  PORTFOLIO_KEYS,
  QUAD_SIDES,
  type ArticlesListKey,
  type BookmarkFolderKey,
  type CommonStyle,
  type DividerPropertyEntry,
  type DropdownPropertyEntry,
  type LinkPseudo,
  type NavMenuDesktopKey,
  type PortfolioKey,
  type PropertyEntry,
  type QuadPropertyEntry,
  type ResolvedPropertyGroup,
  type SinglePropertyEntry,
  type TextShadowPropertyEntry,
} from '../styles/types';
import { renderColorPickerRow } from './colorPicker';
import type { PaletteKey } from '../siteSettings';

// ──────────────────────────────────────────────────────────────────────────
// Public options + entry point
// ──────────────────────────────────────────────────────────────────────────

export interface RenderPropertyPanelOptions {
  /** Runtime scope. 'page' for the page itself, '<blockType>:<blockId>'
   *  for a block-level panel. Used as `data-style-scope` on every input
   *  so the input-delegation in NospressView can dispatch correctly. */
  scope: string;
  /** Active style values (used to populate input `value` attributes).
   *  When breakpoint tabs are active, this is the resolved slot for the
   *  currently-selected tab — caller does the slot-picking. */
  style: CommonStyle | undefined;
  /** Active HTML-attribute overrides (`class` / `id` on the block wrapper).
   *  Only meaningful for block scopes — the page wrapper is always
   *  `.user-site`, so this is ignored when scope === 'page'. */
  attrs?: { class?: string; id?: string } | undefined;
  /** Currently selected divider side in the Top/Bottom switch (only
   *  relevant when the schema includes the divider property). Default top. */
  activeDividerSide?: 'top' | 'bottom';
  /** Effective palette (user overrides + Deep Purple defaults) used to
   *  paint the inline color swatches with the user's actual colors,
   *  without pushing CSS variables onto the editor scope. The clicked
   *  swatch still records `var(--color-N)` so the public site tracks
   *  palette changes dynamically. */
  palette?: Partial<Record<PaletteKey, string>>;
  /** Breakpoint tabs row at the top of the panel. Empty / undefined
   *  array = no tabs rendered (single-style block). The first tab in
   *  the array is mobile-first / base; selecting it edits `block.style`.
   *  Subsequent tabs edit `block.breakpointStyles[<name>]`. */
  breakpointTabs?: Array<{ name: string; label: string }>;
  /** Currently active breakpoint tab name. Must match one of
   *  `breakpointTabs[i].name`. */
  activeBreakpoint?: string;
  /** Block-type-specific extra controls (e.g. nav-menu's Horizontal
   *  toggle). Rendered between the Identifiers section and the standard
   *  property rows. Caller is responsible for the inner HTML; tabs +
   *  base styling come from `.nn-checkbox` / `.form__row` etc. */
  extras?: string;
  /** Optional raw HTML to render in the panel header slot instead of the
   *  breakpoint tabs. Used by sub-scope panels (e.g. nav-menu's Mobile
   *  Menu) to show a single-line title where the tabs would normally be.
   *  When set, `breakpointTabs` is ignored. */
  header?: string;
  /** When set, overrides the schema resolved from `groupedSchemaFor(scope)`.
   *  Used by multi-block selection to render only the intersection of all
   *  selected blocks' schemas (the common-denominator property set). */
  groupsOverride?: ResolvedPropertyGroup[];
  /** Optional set of fully-qualified style field paths whose value differs
   *  across the selected blocks. The input for any path in this set
   *  renders with an empty value and a "(modified)" placeholder so the
   *  user sees the inputs are "mixed". Writing into such a field will
   *  overwrite the value on every selected block. */
  mixedFields?: ReadonlySet<string>;
}

export function renderPropertyPanel(opts: RenderPropertyPanelOptions): string {
  // Mobile-menu sub-scope is rendered through a dedicated path that
  // splits the panel into per-selector accordion sections (ul/li/a/...).
  // It still goes through the same panel chrome (header / identifiers
  // are skipped by the sub-scope caller), so the branch happens here.
  if (opts.scope.startsWith('nav-menu-mobile')) {
    return renderMobileMenuSubScopePanel(opts);
  }
  const groups = opts.groupsOverride ?? groupedSchemaFor(opts.scope);
  return renderPanelInternal(opts, groups, '');
}

// ──────────────────────────────────────────────────────────────────────────
// Group / entry rendering
// ──────────────────────────────────────────────────────────────────────────

/** Render just the per-group body markup (no panel chrome). Pure
 *  function over (opts, groups, fieldPrefix) — used by both the
 *  regular panel and the mobile-menu sub-scope's accordion sections.
 *  The prefix lets sub-scope sections write to nested paths
 *  (`mobileMenu.<sec>.<prop>`) without each entry-render function
 *  having to know about sub-scope semantics. */
function renderEntriesForGroups(
  opts: RenderPropertyPanelOptions,
  groups: ResolvedPropertyGroup[],
  fieldPrefix: string,
): string {
  const scopeAttr = escapeHtmlAttr(opts.scope);
  // Resolve the value for a sub-path. When the path is in `mixedFields`,
  // the inputs render empty so the "(modified)" placeholder is visible.
  // Writing any non-empty value into the field overwrites all selected
  // blocks (multi-block) or the single block (single-mode) uniformly.
  const isMixed = (subPath: string): boolean => !!opts.mixedFields?.has(fieldPrefix + subPath);
  const v = (subPath: string): string => isMixed(subPath)
    ? ''
    : escapeHtmlAttr(readStyleField(opts.style, fieldPrefix + subPath) ?? '');
  /** Placeholder text for an input. If the field is mixed across the
   *  multi-selection, override the catalog-provided placeholder with
   *  "(modified)" so the user sees the inputs aren't on consensus. */
  const ph = (subPath: string, fallback: string): string => isMixed(subPath)
    ? '(modified)'
    : fallback;
  const palette = opts.palette ?? {};

  const single = (e: SinglePropertyEntry) => {
    if (e.cssProp === 'color' || e.cssProp === 'background') return colorRow(e);
    return `
      <div class="nospress-prop-row">
        <label class="nospress-prop-row__label">${escapeHtmlAttr(e.label)}</label>
        <input type="text" class="input nospress-prop-row__input"
               data-style-scope="${scopeAttr}" data-style-field="${fieldPrefix}${e.key}"
               value="${v(e.key)}" placeholder="${escapeHtmlAttr(ph(e.key, e.placeholder))}" />
      </div>
    `;
  };

  /** Color/Background row delegates to the shared helper. Background
   *  gets the gradient swatch + gradient-editor mount slot; plain Color
   *  doesn't (gradient is a fill concept, not a foreground concept). */
  const colorRow = (e: SinglePropertyEntry) => renderColorPickerRow({
    scope: opts.scope,
    field: fieldPrefix + e.key,
    label: e.label,
    value: v(e.key),
    placeholder: isMixed(e.key) ? '(modified)' : e.placeholder,
    palette,
    includeGradient: e.cssProp === 'background',
  });

  const quad = (e: QuadPropertyEntry) => {
    const basePh = e.placeholder ?? '0px';
    return `
      <div class="nospress-prop-row">
        <label class="nospress-prop-row__label">${escapeHtmlAttr(e.label)}</label>
        <div class="nospress-prop-quad">
          ${QUAD_SIDES.map(side => `
            <div class="nospress-prop-quad__cell">
              <input type="text" class="input nospress-prop-quad__input"
                     data-style-scope="${scopeAttr}" data-style-field="${fieldPrefix}${e.key}.${side}"
                     value="${v(`${e.key}.${side}`)}" placeholder="${escapeHtmlAttr(ph(`${e.key}.${side}`, basePh))}" />
              <span class="nospress-prop-quad__caption">${side.charAt(0).toUpperCase()}${side.slice(1)}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  };

  /** Dropdown row — emits a slot div that NospressView's
   *  `mountStyleDropdowns` fills with a `CustomDropdown` instance. */
  const dropdown = (e: DropdownPropertyEntry) => {
    // Pre-fill: stored value wins, else a per-key fallback. `display`
    // uses the block's natural CSS default; `position` defaults to
    // `relative` everywhere (rather than the CSS-spec `static`) so
    // descendant absolute children resolve against the block by
    // default. `borderStyle` has its own `(none)` first option, no
    // fallback needed.
    const stored = v(e.key);
    const fallback = e.key === 'display' ? getDefaultDisplayFor(opts.scope, fieldPrefix)
      : e.key === 'position' ? 'relative'
      : '';
    const current = stored || fallback;
    const mixed = isMixed(e.key);
    return `
      <div class="nospress-prop-row">
        <label class="nospress-prop-row__label">${escapeHtmlAttr(e.label)}</label>
        <div class="nospress-prop-row__input"
             data-style-dropdown
             data-style-scope="${scopeAttr}"
             data-style-field="${fieldPrefix}${e.key}"
             data-current-value="${escapeHtmlAttr(mixed ? '' : current)}"
             ${mixed ? `data-placeholder="${escapeHtmlAttr('(modified)')}"` : ''}
             data-options="${escapeHtmlAttr(JSON.stringify(e.options))}"></div>
      </div>
    `;
  };

  /** Render the Top/Bottom switch + the edit area for the currently
   *  active side. Active side is controlled by the caller (`opts.activeDividerSide`)
   *  so it persists across re-renders driven by other property changes.
   *  The picked value targets `divider.<side>` directly — no per-side
   *  Color or Height (fill is always `var(--color-1)`, height comes from
   *  the catalog entry). Effect-only.
   *
   *  Below the picker, a single global `flipX` checkbox mirrors every
   *  divider on this block horizontally. Same checkbox state is shown on
   *  Top and Bottom — toggling once flips both. */
  const dividerSide = (side: 'top' | 'bottom') => {
    const styleVal = v(`divider.${side}`) || 'none';
    const styleField = `${fieldPrefix}divider.${side}`;
    // Use the prefix-aware reader so per-sub-scope divider state (currently
    // unused — no mobile-menu section includes the divider entry) would
    // resolve correctly if it ever gets surfaced.
    const flipXChecked = (v('divider.flipX') === '1');
    const flipYChecked = (v('divider.flipY') === '1');

    const styleOptionsHtml = DIVIDER_STYLE_OPTIONS.map(opt => `
      <button type="button"
              class="nospress-divider-picker__option ${opt.value === styleVal ? 'is-selected' : ''}"
              data-divider-style-pick="${opt.value}"
              data-style-scope="${scopeAttr}"
              data-style-field="${styleField}"
              aria-label="${escapeHtmlAttr(opt.label)}">
        <span class="nospress-divider-picker__option-thumb">${dividerThumbSvg(opt.value)}</span>
        <span class="nospress-divider-picker__option-label">${escapeHtmlAttr(opt.label)}</span>
      </button>
    `).join('');

    const selectedOpt = DIVIDER_STYLE_OPTIONS.find(o => o.value === styleVal) ?? DIVIDER_STYLE_OPTIONS[0]!;

    return `
      <div class="nospress-prop-row">
        <label class="nospress-prop-row__label">Style</label>
        <div class="nospress-divider-picker" data-divider-picker>
          <button type="button" class="nospress-divider-picker__trigger" data-divider-picker-toggle aria-haspopup="listbox">
            <span class="nospress-divider-picker__trigger-thumb">${dividerThumbSvg(styleVal)}</span>
            <span class="nospress-divider-picker__trigger-label">${escapeHtmlAttr(selectedOpt.label)}</span>
          </button>
          <div class="nospress-divider-picker__menu" data-divider-picker-menu hidden>
            ${styleOptionsHtml}
          </div>
        </div>
      </div>
      <label class="nn-checkbox nn-checkbox--label-left">
        <span>Flip horizontally</span>
        <input type="checkbox"
               data-style-scope="${scopeAttr}"
               data-style-field="${fieldPrefix}divider.flipX"
               ${flipXChecked ? 'checked' : ''} />
      </label>
      <label class="nn-checkbox nn-checkbox--label-left">
        <span>Flip vertically</span>
        <input type="checkbox"
               data-style-scope="${scopeAttr}"
               data-style-field="${fieldPrefix}divider.flipY"
               ${flipYChecked ? 'checked' : ''} />
      </label>
    `;
  };

  /** Render the Text-shadow group as two paired rows: H + V on one row,
   *  blur + color on the next. The four sub-fields write to
   *  `textShadow.h|v|blur|color` via the standard `data-style-field`
   *  dispatch; `composeTextShadow` joins them into a single CSS
   *  declaration at render time.
   *
   *  No own header — the parent Typography group section header scopes
   *  it. The pair containers collapse to single-column at narrow widths
   *  via the standard `.nospress-prop-pair` grid. */
  const textShadowCell = (axis: 'h' | 'v', label: string, placeholder: string) => `
    <div class="nospress-prop-pair__cell">
      <div class="nospress-prop-row">
        <label class="nospress-prop-row__label">${label}</label>
        <input type="text" class="input nospress-prop-row__input"
               data-style-scope="${scopeAttr}" data-style-field="${fieldPrefix}textShadow.${axis}"
               value="${v(`textShadow.${axis}`)}" placeholder="${escapeHtmlAttr(ph(`textShadow.${axis}`, placeholder))}" />
      </div>
    </div>
  `;
  const textShadow = (_e: TextShadowPropertyEntry) => `
    <div class="nospress-prop-pair">
      ${textShadowCell('h', 'Text shadow H', 'e.g. 2px')}
      ${textShadowCell('v', 'Text shadow V', 'e.g. 2px')}
    </div>
    <div class="nospress-prop-pair">
      <div class="nospress-prop-pair__cell">
        <div class="nospress-prop-row">
          <label class="nospress-prop-row__label">Text shadow blur</label>
          <input type="text" class="input nospress-prop-row__input"
                 data-style-scope="${scopeAttr}" data-style-field="${fieldPrefix}textShadow.blur"
                 value="${v('textShadow.blur')}" placeholder="${escapeHtmlAttr(ph('textShadow.blur', 'e.g. 4px'))}" />
        </div>
      </div>
      <div class="nospress-prop-pair__cell">
        ${renderColorPickerRow({
          scope: opts.scope,
          field: `${fieldPrefix}textShadow.color`,
          label: 'Text shadow color',
          value: v('textShadow.color'),
          placeholder: ph('textShadow.color', 'e.g. #000'),
          palette,
        })}
      </div>
    </div>
  `;

  const divider = (_e: DividerPropertyEntry) => {
    const active = opts.activeDividerSide ?? 'top';
    return `
      <div class="nospress-prop-row">
        <label class="nospress-prop-row__label">Side</label>
        <div class="nospress-prop-divider__sideswitch" role="tablist">
          <button type="button" class="nospress-prop-divider__sideswitch-btn ${active === 'top' ? 'is-active' : ''}" data-divider-side-switch="top">Top</button>
          <button type="button" class="nospress-prop-divider__sideswitch-btn ${active === 'bottom' ? 'is-active' : ''}" data-divider-side-switch="bottom">Bottom</button>
        </div>
      </div>
      ${dividerSide(active)}
    `;
  };

  const renderEntry = (entry: PropertyEntry): string => {
    // Conditional: positionInsets only surfaces when the current
    // `position` value is `absolute` or `sticky` — otherwise the
    // four offset inputs would do nothing and just clutter the panel.
    if (entry.kind === 'quad' && entry.key === 'positionInsets') {
      // Match the panel's pre-fill default for `position` (see
      // `dropdown` closure above) so the conditional behaves the same
      // whether or not the user has explicitly picked a value.
      const pos = readStyleField(opts.style, fieldPrefix + 'position') || 'relative';
      if (pos !== 'absolute' && pos !== 'sticky') return '';
    }
    // Conditional: gridGap only surfaces when the effective `display` is
    // `grid` or `inline-grid` — otherwise `gap` is a no-op and the row
    // would just clutter the Layout group. Mirrors the display
    // dropdown's pre-fill default so the conditional kicks in even when
    // the user hasn't explicitly set `display`.
    if (entry.kind === 'single' && entry.key === 'gridGap') {
      const display = readStyleField(opts.style, fieldPrefix + 'display')
        || getDefaultDisplayFor(opts.scope, fieldPrefix);
      if (display !== 'grid' && display !== 'inline-grid') return '';
    }
    return entry.kind === 'single' ? single(entry)
      : entry.kind === 'quad' ? quad(entry)
      : entry.kind === 'dropdown' ? dropdown(entry)
      : entry.kind === 'text-shadow' ? textShadow(entry)
      : divider(entry);
  };

  // Paired entries (declared as nested arrays in PropertyGroup.props) wrap
  // their rendered rows in `.nospress-prop-pair` so CSS-grid lays them
  // side-by-side at wide panel widths and stacks them at narrow widths
  // (responsive via `auto-fit minmax`). Each cell wraps ONE entry so the
  // color-picker's sibling popover / gradient mount stays inside its
  // own pair cell instead of leaking into the neighbour column.
  const renderEntryOrPair = (e: PropertyEntry | PropertyEntry[]): string => {
    if (!Array.isArray(e)) return renderEntry(e);
    const cells = e
      .map(sub => renderEntry(sub))
      .filter(html => html.length > 0)
      .map(html => `<div class="nospress-prop-pair__cell">${html}</div>`);
    if (cells.length === 0) return '';
    // Lone surviving cell (one of the paired entries was conditionally
    // hidden — e.g. positionInsets without absolute) renders as a normal
    // single row to avoid an empty grid column.
    if (cells.length === 1) return e
      .map(sub => renderEntry(sub))
      .find(html => html.length > 0) ?? '';
    return `<div class="nospress-prop-pair">${cells.join('')}</div>`;
  };

  // Group sections — one section per resolved group, containing all of
  // its entries in declaration order. Section header is a plain `<h3
  // class="h3">` so it inherits the project's heading typography +
  // standard `margin-bottom: $gap` (see _typography.scss). Section
  // wrapper keeps a `data-group-key` for accordion-state hooks
  // downstream (mobile-menu sub-scope).
  return groups.map(g => `
    <section class="nospress-prop-group" data-group-key="${escapeHtmlAttr(g.key)}">
      <h3 class="h3">${escapeHtmlAttr(g.label)}</h3>
      ${g.entries.map(renderEntryOrPair).join('')}
    </section>
  `).join('');
}

// ──────────────────────────────────────────────────────────────────────────
// Panel chrome (header + identifiers + extras + body + sub-scopes)
// ──────────────────────────────────────────────────────────────────────────

/** Wrap a body in the standard panel chrome: header (tabs OR caller-
 *  provided header), identifiers, extras, body. Both the regular and
 *  the mobile-menu sub-scope paths terminate here. */
function renderPanelInternal(
  opts: RenderPropertyPanelOptions,
  groups: ResolvedPropertyGroup[],
  fieldPrefix: string,
): string {
  const scopeAttr = escapeHtmlAttr(opts.scope);
  const mainBody = renderEntriesForGroups(opts, groups, fieldPrefix);
  // Link sub-scope: 5 accordion sections (link/visited/hover/focus/active)
  // appended to the panel body for any block whose rendered output can
  // contain `<a>` elements. Same `nn-ui-toggle` accordion molecule as the
  // mobile-menu sub-scope so the existing toggle handler in NospressView
  // works without changes. Empty for non-block scopes (`page`) and for
  // sub-scope panels (handled separately above) and for sub-scope fields
  // already (no nested links inside links).
  const blockType = matrixKey(opts.scope);
  const showLinks = !fieldPrefix
    && BLOCKS_WITH_LINKS_SUBSCOPE.has(blockType);
  // Nav-menu desktop sub-scope: ul/li sections appear ABOVE the link
  // sub-scope (structural list/item styling first), aActive appears
  // BELOW it (active-page indicator after the generic link pseudos).
  // Mobile-menu drawer styling stays in its own dedicated panel
  // (opened via the hamburger trigger in the editor).
  const showNavMenuDesktop = !fieldPrefix && blockType === 'nav-menu';
  const navMenuTopBody = showNavMenuDesktop ? renderNavMenuDesktopSections(opts, ['ul', 'li']) : '';
  const navMenuBottomBody = showNavMenuDesktop ? renderNavMenuDesktopSections(opts, ['aActive']) : '';
  const linksBody = showLinks ? renderLinkSubScopeSections(opts) : '';
  // Bookmark-folder sub-scope: 3 narrow sections (item/icon/desc), each
  // restricted to a single property. Rendered AFTER the link sub-scope
  // since the link styling is the more common case.
  const showBookmarkFolder = !fieldPrefix && blockType === 'bookmark-folder';
  const bookmarkFolderBody = showBookmarkFolder ? renderBookmarkFolderSections(opts) : '';
  // Articles-list sub-scope: 3 narrow sections (card/title/meta) on the
  // rendered `.nn-card` carousel tiles. Same single-property pattern.
  const showArticlesList = !fieldPrefix && blockType === 'articles-list';
  const articlesListBody = showArticlesList ? renderArticlesListSections(opts) : '';
  // Portfolio sub-scope: 2 sections (close button default + hover) for
  // the expanded-card close icon. Each section exposes icon color +
  // circle background.
  const showPortfolio = !fieldPrefix && blockType === 'portfolio';
  const portfolioBody = showPortfolio ? renderPortfolioSections(opts) : '';
  // Weblog sub-scope: 3 sections (note default + hover, ISL row) placed
  // BEFORE the link pseudos so the note-card chrome is closer to the
  // main block properties than the inner-link styling.
  const showWeblog = !fieldPrefix && blockType === 'weblog';
  const weblogBody = showWeblog ? renderWeblogSections(opts) : '';
  const specificBody = (opts.extras ?? '')
    + navMenuTopBody + weblogBody + linksBody + navMenuBottomBody
    + bookmarkFolderBody + articlesListBody + portfolioBody;

  // Identifiers section — only for block scopes. The page itself doesn't get
  // a configurable class/id (its wrapper is always `.user-site`). Paired
  // so the two narrow inputs share one row at wide panel widths and
  // collapse to stacked at narrow widths via `.nospress-prop-pair`.
  const identifiersHtml = opts.scope === 'page' ? '' : `
    <div class="nospress-prop-pair">
      <div class="nospress-prop-pair__cell">
        <div class="nospress-prop-row">
          <label class="nospress-prop-row__label">CSS Class</label>
          <input type="text" class="input nospress-prop-row__input"
                 data-attr-scope="${scopeAttr}" data-attr-field="class"
                 value="${escapeHtmlAttr(opts.attrs?.class ?? '')}" placeholder="e.g. hero featured" />
        </div>
      </div>
      <div class="nospress-prop-pair__cell">
        <div class="nospress-prop-row">
          <label class="nospress-prop-row__label">CSS ID</label>
          <input type="text" class="input nospress-prop-row__input"
                 data-attr-scope="${scopeAttr}" data-attr-field="id"
                 value="${escapeHtmlAttr(opts.attrs?.id ?? '')}" placeholder="e.g. main-cta" />
        </div>
      </div>
    </div>
  `;

  // Header slot: caller-provided raw HTML wins (used by sub-scope panels
  // to show a title in place of the tabs); otherwise breakpoint tabs are
  // rendered when defined; otherwise nothing.
  const tabs = opts.breakpointTabs ?? [];
  const activeBp = opts.activeBreakpoint ?? '';
  const headerHtml = opts.header ?? (tabs.length > 0
    ? `
      <div class="tabs nospress-block-properties__tabs">
        ${tabs.map(t => `
          <button type="button"
                  class="tab${t.name === activeBp ? ' tab--active' : ''}"
                  data-bp-tab="${escapeHtmlAttr(t.name)}">
            <span class="tab__label">${escapeHtmlAttr(t.label)}</span>
          </button>
        `).join('')}
      </div>
    `
    : '');

  // The panel body is split into two semantic groups: a "General"
  // fieldset that wraps the identifiers and the standard CSS-property
  // groups (Spacing/Sizing/Typography/Background/Border), and a
  // "Specific" fieldset that wraps the block-specific structural
  // controls (`extras`) plus every sub-scope section (link pseudos,
  // nav-menu ul/li/aActive, weblog, bookmark-folder, articles-list,
  // portfolio). The Specific fieldset is omitted when empty so simple
  // blocks (heading, text, divider) don't show a dangling box.
  const generalFieldset = `
    <fieldset>
      <legend>General</legend>
      ${identifiersHtml}
      ${mainBody}
    </fieldset>
  `;
  const specificFieldset = specificBody.trim() ? `
    <fieldset>
      <legend>Specific</legend>
      ${specificBody}
    </fieldset>
  ` : '';

  return `
    <div class="nospress-block-properties" data-properties-for="${scopeAttr}">
      ${headerHtml}
      <div class="nospress-block-properties__body">
        ${generalFieldset}
        ${specificFieldset}
      </div>
    </div>
  `;
}

// ──────────────────────────────────────────────────────────────────────────
// Sub-scope section renderers
// ──────────────────────────────────────────────────────────────────────────

/** Mobile-menu sub-scope panel — one accordion section per drawer
 *  selector, each containing the standard property groups for that
 *  selector (defined in `MOBILE_MENU_SECTIONS`). Inputs write to the
 *  nested `mobileMenu.<sec>.<prop>` slot via the `fieldPrefix` mechanism
 *  in `renderPanelInternal`.
 *
 *  Reuses `nn-ui-toggle` for the accordion (same molecule the Global
 *  tab uses), with `data-toggle-section` / `data-toggle-header` so the
 *  existing click handler in NospressView toggles the `.open` class. */
function renderMobileMenuSubScopePanel(opts: RenderPropertyPanelOptions): string {
  const scopeAttr = escapeHtmlAttr(opts.scope);
  const sectionsHtml = MOBILE_MENU_SECTIONS.map((sec, idx) => {
    // First section (Drawer / ul) starts open; the rest collapsed.
    const open = idx === 0 ? ' open' : '';
    // Resolve this section's groups against the catalog so the body
    // renderer gets ready-to-emit `PropertyEntry` instances.
    const resolvedGroups: ResolvedPropertyGroup[] = sec.groups.map(g => ({
      key: g.key,
      label: g.label,
      entries: resolveGroupEntries(g.props),
    }));
    // Emit just the body markup (groups + their entries) for this
    // section, bypassing the panel chrome — that's owned by the outer
    // wrapper below.
    const sectionBody = renderEntriesForGroups(opts, resolvedGroups, `mobileMenu.${sec.key}.`);
    return `
      <section class="nn-ui-toggle nospress-prop-mobile-section${open}" data-toggle-section data-mobile-section="${sec.key}">
        <div class="nn-ui-toggle__header" data-toggle-header>
          <div class="nn-ui-toggle__info">
            <h2 class="nn-ui-toggle__title">${escapeHtmlAttr(sec.label)}</h2>
          </div>
          <button class="nn-ui-toggle__toggle" aria-label="Toggle section">
            <svg width="16" height="16"><use href="#icon-chevron-down"/></svg>
          </button>
        </div>
        <div class="nn-ui-toggle__content">
          ${sectionBody}
        </div>
      </section>
    `;
  }).join('');

  return `
    <div class="nospress-block-properties" data-properties-for="${scopeAttr}">
      ${opts.header ?? ''}
      <div class="nospress-block-properties__body">
        ${sectionsHtml}
      </div>
    </div>
  `;
}

/** Per-block link sub-scope panel — 5 accordion sections, one per
 *  pseudo-class, appended below the main block properties for blocks
 *  in `BLOCKS_WITH_LINKS_SUBSCOPE`. Reuses `LINK_SUBSCOPE_GROUPS` (no
 *  sizing — `<a>` is inline by default). Inputs write to nested
 *  `links.<pseudo>.<prop>` slots via the `fieldPrefix` mechanism. */
const LINK_PSEUDO_LABELS: Record<LinkPseudo, string> = {
  link:    'Link (a:link)',
  visited: 'Visited (a:visited)',
  hover:   'Hover (a:hover)',
  focus:   'Focus (a:focus)',
  active:  'Active (a:active)',
};

const NAV_MENU_DESKTOP_LABELS: Record<NavMenuDesktopKey, string> = {
  ul: 'List (ul)',
  li: 'Items (li)',
  aActive: 'Active page link (li.active a)',
};

function renderNavMenuDesktopSections(
  opts: RenderPropertyPanelOptions,
  keys: ReadonlyArray<NavMenuDesktopKey>,
): string {
  const resolvedGroups: ResolvedPropertyGroup[] = NAV_MENU_DESKTOP_GROUPS.map(g => ({
    key: g.key,
    label: g.label,
    entries: resolveGroupEntries(g.props),
  }));
  return keys.map(key => {
    const sectionBody = renderEntriesForGroups(opts, resolvedGroups, `navMenu.${key}.`);
    return `
      <section class="nn-ui-toggle nospress-prop-link-section" data-toggle-section data-nav-menu-section="${key}">
        <div class="nn-ui-toggle__header" data-toggle-header>
          <div class="nn-ui-toggle__info">
            <h2 class="nn-ui-toggle__title">${escapeHtmlAttr(NAV_MENU_DESKTOP_LABELS[key])}</h2>
          </div>
          <button class="nn-ui-toggle__toggle" aria-label="Toggle section">
            <svg width="16" height="16"><use href="#icon-chevron-down"/></svg>
          </button>
        </div>
        <div class="nn-ui-toggle__content">
          ${sectionBody}
        </div>
      </section>
    `;
  }).join('');
}

const BOOKMARK_FOLDER_LABELS: Record<BookmarkFolderKey, string> = {
  item: 'Items (.profile-list-item)',
  icon: 'Icons (.profile-list-item__icon)',
  desc: 'Description (.profile-list-item__desc)',
};

function renderBookmarkFolderSections(opts: RenderPropertyPanelOptions): string {
  return BOOKMARK_FOLDER_KEYS.map(key => {
    const resolvedGroups: ResolvedPropertyGroup[] = BOOKMARK_FOLDER_GROUPS[key].map(g => ({
      key: g.key,
      label: g.label,
      entries: resolveGroupEntries(g.props),
    }));
    const sectionBody = renderEntriesForGroups(opts, resolvedGroups, `bookmarkFolder.${key}.`);
    return `
      <section class="nn-ui-toggle nospress-prop-link-section" data-toggle-section data-bookmark-folder-section="${key}">
        <div class="nn-ui-toggle__header" data-toggle-header>
          <div class="nn-ui-toggle__info">
            <h2 class="nn-ui-toggle__title">${escapeHtmlAttr(BOOKMARK_FOLDER_LABELS[key])}</h2>
          </div>
          <button class="nn-ui-toggle__toggle" aria-label="Toggle section">
            <svg width="16" height="16"><use href="#icon-chevron-down"/></svg>
          </button>
        </div>
        <div class="nn-ui-toggle__content">
          ${sectionBody}
        </div>
      </section>
    `;
  }).join('');
}

const ARTICLES_LIST_LABELS: Record<ArticlesListKey, string> = {
  card:  'Card (.nn-card)',
  title: 'Title (.nn-card h3)',
  meta:  'Meta (.nn-card .meta)',
};

function renderArticlesListSections(opts: RenderPropertyPanelOptions): string {
  return ARTICLES_LIST_KEYS.map(key => {
    const resolvedGroups: ResolvedPropertyGroup[] = ARTICLES_LIST_GROUPS[key].map(g => ({
      key: g.key,
      label: g.label,
      entries: resolveGroupEntries(g.props),
    }));
    const sectionBody = renderEntriesForGroups(opts, resolvedGroups, `articlesList.${key}.`);
    return `
      <section class="nn-ui-toggle nospress-prop-link-section" data-toggle-section data-articles-list-section="${key}">
        <div class="nn-ui-toggle__header" data-toggle-header>
          <div class="nn-ui-toggle__info">
            <h2 class="nn-ui-toggle__title">${escapeHtmlAttr(ARTICLES_LIST_LABELS[key])}</h2>
          </div>
          <button class="nn-ui-toggle__toggle" aria-label="Toggle section">
            <svg width="16" height="16"><use href="#icon-chevron-down"/></svg>
          </button>
        </div>
        <div class="nn-ui-toggle__content">
          ${sectionBody}
        </div>
      </section>
    `;
  }).join('');
}

const PORTFOLIO_LABELS: Record<PortfolioKey, string> = {
  closeBtn:      'Close button',
  closeBtnHover: 'Close button (hover)',
  pageBtn:       'Pagination button',
  pageBtnHover:  'Pagination button (hover)',
  pageBtnActive: 'Pagination button (active)',
};

function renderPortfolioSections(opts: RenderPropertyPanelOptions): string {
  return PORTFOLIO_KEYS.map(key => {
    const resolvedGroups: ResolvedPropertyGroup[] = PORTFOLIO_GROUPS[key].map(g => ({
      key: g.key,
      label: g.label,
      entries: resolveGroupEntries(g.props),
    }));
    const sectionBody = renderEntriesForGroups(opts, resolvedGroups, `portfolio.${key}.`);
    return `
      <section class="nn-ui-toggle nospress-prop-link-section" data-toggle-section data-portfolio-section="${key}">
        <div class="nn-ui-toggle__header" data-toggle-header>
          <div class="nn-ui-toggle__info">
            <h2 class="nn-ui-toggle__title">${escapeHtmlAttr(PORTFOLIO_LABELS[key])}</h2>
          </div>
          <button class="nn-ui-toggle__toggle" aria-label="Toggle section">
            <svg width="16" height="16"><use href="#icon-chevron-down"/></svg>
          </button>
        </div>
        <div class="nn-ui-toggle__content">
          ${sectionBody}
        </div>
      </section>
    `;
  }).join('');
}

/** Render the weblog sub-scope as TWO accordion sections:
 *  - "Note" merges the `note` (default) + `noteHover` (`:hover`) slots
 *    in a single toggle; the hover side reuses the same property groups
 *    but with " (hover)" suffixed to the group labels so the user sees
 *    both state's color + background inputs next to each other.
 *  - "ISL" stays a standalone toggle. */
function renderWeblogSections(opts: RenderPropertyPanelOptions): string {
  const noteDefaultGroups: ResolvedPropertyGroup[] = WEBLOG_GROUPS.note.map(g => ({
    key: g.key,
    label: g.label,
    entries: resolveGroupEntries(g.props),
  }));
  const noteHoverGroups: ResolvedPropertyGroup[] = WEBLOG_GROUPS.noteHover.map(g => ({
    key: `${g.key}-hover`,
    label: `${g.label} (hover)`,
    entries: resolveGroupEntries(g.props),
  }));
  const noteBody =
    renderEntriesForGroups(opts, noteDefaultGroups, 'weblog.note.') +
    renderEntriesForGroups(opts, noteHoverGroups, 'weblog.noteHover.');

  const islGroups: ResolvedPropertyGroup[] = WEBLOG_GROUPS.isl.map(g => ({
    key: g.key,
    label: g.label,
    entries: resolveGroupEntries(g.props),
  }));
  const islBody = renderEntriesForGroups(opts, islGroups, 'weblog.isl.');

  const loadingGroups: ResolvedPropertyGroup[] = WEBLOG_GROUPS.loading.map(g => ({
    key: g.key,
    label: g.label,
    entries: resolveGroupEntries(g.props),
  }));
  const loadingBody = renderEntriesForGroups(opts, loadingGroups, 'weblog.loading.');

  const metaGroups: ResolvedPropertyGroup[] = WEBLOG_GROUPS.meta.map(g => ({
    key: g.key,
    label: g.label,
    entries: resolveGroupEntries(g.props),
  }));
  const metaBody = renderEntriesForGroups(opts, metaGroups, 'weblog.meta.');

  const mentionGroups: ResolvedPropertyGroup[] = WEBLOG_GROUPS.mention.map(g => ({
    key: g.key,
    label: g.label,
    entries: resolveGroupEntries(g.props),
  }));
  const mentionBody = renderEntriesForGroups(opts, mentionGroups, 'weblog.mention.');

  return `
    <section class="nn-ui-toggle nospress-prop-link-section" data-toggle-section data-weblog-section="note">
      <div class="nn-ui-toggle__header" data-toggle-header>
        <div class="nn-ui-toggle__info">
          <h2 class="nn-ui-toggle__title">Note (.note-card)</h2>
        </div>
        <button class="nn-ui-toggle__toggle" aria-label="Toggle section">
          <svg width="16" height="16"><use href="#icon-chevron-down"/></svg>
        </button>
      </div>
      <div class="nn-ui-toggle__content">
        ${noteBody}
      </div>
    </section>
    <section class="nn-ui-toggle nospress-prop-link-section" data-toggle-section data-weblog-section="isl">
      <div class="nn-ui-toggle__header" data-toggle-header>
        <div class="nn-ui-toggle__info">
          <h2 class="nn-ui-toggle__title">ISL (.isl-action)</h2>
        </div>
        <button class="nn-ui-toggle__toggle" aria-label="Toggle section">
          <svg width="16" height="16"><use href="#icon-chevron-down"/></svg>
        </button>
      </div>
      <div class="nn-ui-toggle__content">
        ${islBody}
      </div>
    </section>
    <section class="nn-ui-toggle nospress-prop-link-section" data-toggle-section data-weblog-section="loading">
      <div class="nn-ui-toggle__header" data-toggle-header>
        <div class="nn-ui-toggle__info">
          <h2 class="nn-ui-toggle__title">Loading (.nospress-block-weblog__loading)</h2>
        </div>
        <button class="nn-ui-toggle__toggle" aria-label="Toggle section">
          <svg width="16" height="16"><use href="#icon-chevron-down"/></svg>
        </button>
      </div>
      <div class="nn-ui-toggle__content">
        ${loadingBody}
      </div>
    </section>
    <section class="nn-ui-toggle nospress-prop-link-section" data-toggle-section data-weblog-section="meta">
      <div class="nn-ui-toggle__header" data-toggle-header>
        <div class="nn-ui-toggle__info">
          <h2 class="nn-ui-toggle__title">Date + Handle row</h2>
        </div>
        <button class="nn-ui-toggle__toggle" aria-label="Toggle section">
          <svg width="16" height="16"><use href="#icon-chevron-down"/></svg>
        </button>
      </div>
      <div class="nn-ui-toggle__content">
        ${metaBody}
      </div>
    </section>
    <section class="nn-ui-toggle nospress-prop-link-section" data-toggle-section data-weblog-section="mention">
      <div class="nn-ui-toggle__header" data-toggle-header>
        <div class="nn-ui-toggle__info">
          <h2 class="nn-ui-toggle__title">Mention (.mention-link--bg)</h2>
        </div>
        <button class="nn-ui-toggle__toggle" aria-label="Toggle section">
          <svg width="16" height="16"><use href="#icon-chevron-down"/></svg>
        </button>
      </div>
      <div class="nn-ui-toggle__content">
        ${mentionBody}
      </div>
    </section>
  `;
}

function renderLinkSubScopeSections(opts: RenderPropertyPanelOptions): string {
  const resolvedGroups: ResolvedPropertyGroup[] = LINK_SUBSCOPE_GROUPS.map(g => ({
    key: g.key,
    label: g.label,
    entries: resolveGroupEntries(g.props),
  }));
  return LINK_PSEUDO_KEYS.map(pseudo => {
    // All collapsed by default — rare-use sub-scope, don't crowd the
    // panel on every block selection.
    const sectionBody = renderEntriesForGroups(opts, resolvedGroups, `links.${pseudo}.`);
    return `
      <section class="nn-ui-toggle nospress-prop-link-section" data-toggle-section data-link-pseudo="${pseudo}">
        <div class="nn-ui-toggle__header" data-toggle-header>
          <div class="nn-ui-toggle__info">
            <h2 class="nn-ui-toggle__title">${escapeHtmlAttr(LINK_PSEUDO_LABELS[pseudo])}</h2>
          </div>
          <button class="nn-ui-toggle__toggle" aria-label="Toggle section">
            <svg width="16" height="16"><use href="#icon-chevron-down"/></svg>
          </button>
        </div>
        <div class="nn-ui-toggle__content">
          ${sectionBody}
        </div>
      </section>
    `;
  }).join('');
}
