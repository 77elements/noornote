/**
 * Catalog + matrix definitions.
 *
 * Architecture (matrix design):
 *
 *   PROPERTY_CATALOG    — single source of truth for every property:
 *                         the CSS mapping, the input kind (single / quad),
 *                         the label, the placeholder.
 *
 *   STYLE_MATRIX        — for each scope ('page', or a block type), lists
 *                         the property keys the user is allowed to set.
 *                         Adding a property to a new block type = ONE entry
 *                         in this matrix. Adding a brand-new property =
 *                         one entry in PROPERTY_CATALOG.
 *
 *   schemaFor(scope)    — resolves a scope to its PropertyEntry[] schema,
 *                         used by the renderer.
 *
 * Pure data + resolver helpers — no DOM access here.
 */

import type {
  ArticlesListKey,
  BookmarkFolderKey,
  MobileMenuSection,
  MobileMenuSectionDef,
  PortfolioKey,
  PropertyEntry,
  PropertyGroup,
  PropertyKey,
  ResolvedPropertyGroup,
  WeblogKey,
} from './types';

// ──────────────────────────────────────────────────────────────────────────
// Catalog
// ──────────────────────────────────────────────────────────────────────────

export const PROPERTY_CATALOG: Record<PropertyKey, PropertyEntry> = {
  color:        { kind: 'single', key: 'color',        label: 'Color',         cssProp: 'color',         placeholder: 'e.g. #ede2da' },
  background:   { kind: 'single', key: 'background',   label: 'Background',    cssProp: 'background',    placeholder: 'e.g. #0f0d23' },
  fontSize:     { kind: 'single', key: 'fontSize',     label: 'Font size',     cssProp: 'font-size',     placeholder: 'e.g. 1rem' },
  lineHeight:   { kind: 'single', key: 'lineHeight',   label: 'Line height',   cssProp: 'line-height',   placeholder: 'e.g. 1.5' },
  fontWeight:   { kind: 'single', key: 'fontWeight',   label: 'Font weight',   cssProp: 'font-weight',   placeholder: '400 | 600 | bold' },
  fontStyle:    { kind: 'single', key: 'fontStyle',    label: 'Font style',    cssProp: 'font-style',    placeholder: 'normal | italic' },
  fontFamily: {
    // Options here are the static system fallbacks. NospressView's
    // `mountStyleDropdowns` augments this list with the user's uploaded
    // custom fonts (from siteSettings.theme.customFonts) before mounting
    // the CustomDropdown — so adding a font in the Global tab makes it
    // appear in every block's dropdown without re-rendering the catalog.
    kind: 'dropdown', key: 'fontFamily', label: 'Font family', cssProp: 'font-family',
    options: [
      { value: '',                                                  label: '(default)' },
      { value: 'system-ui, sans-serif',                             label: 'System' },
      { value: 'Arial, sans-serif',                                 label: 'Arial' },
      { value: '"Times New Roman", Times, serif',                   label: 'Times New Roman' },
      { value: 'Georgia, serif',                                    label: 'Georgia' },
      { value: '"Trebuchet MS", sans-serif',                        label: 'Trebuchet' },
      { value: 'Verdana, sans-serif',                               label: 'Verdana' },
      { value: '"Courier New", Courier, monospace',                 label: 'Courier' },
    ],
  },
  // Border split into 3 properties: width (quad), style (dropdown), color (quad).
  // All emit shorthand declarations so the rendered CSS stays compact.
  borderWidth:  { kind: 'quad',   key: 'borderWidth',  label: 'Border width',  cssShorthand: 'border-width', placeholder: 'e.g. 1px' },
  borderStyle:  {
    kind: 'dropdown', key: 'borderStyle', label: 'Border style', cssProp: 'border-style',
    options: [
      { value: '',       label: '(none)' },
      { value: 'solid',  label: 'Solid' },
      { value: 'dashed', label: 'Dashed' },
      { value: 'dotted', label: 'Dotted' },
      { value: 'double', label: 'Double' },
    ],
  },
  borderColor:  { kind: 'quad',   key: 'borderColor',  label: 'Border color',  cssShorthand: 'border-color', placeholder: 'e.g. var(--color-3)' },
  borderRadius: { kind: 'single', key: 'borderRadius', label: 'Border radius', cssProp: 'border-radius', placeholder: 'e.g. 8px' },
  width:        { kind: 'single', key: 'width',        label: 'Width',         cssProp: 'width',         placeholder: 'e.g. 100%, 800px, 60ch' },
  height:       { kind: 'single', key: 'height',       label: 'Height',        cssProp: 'height',        placeholder: 'e.g. 480px, 60vh, auto' },
  textDecoration: {
    kind: 'dropdown', key: 'textDecoration', label: 'Text decoration', cssProp: 'text-decoration',
    options: [
      { value: 'none',         label: 'none' },
      { value: 'underline',    label: 'underline' },
      { value: 'overline',     label: 'overline' },
      { value: 'line-through', label: 'line-through' },
    ],
  },
  textAlign: {
    // First option is the empty "(default)" entry — same rationale as
    // `alignButton`: CustomDropdown's trigger-label falls back to
    // options[0].label when the backing slot has no value, so without an
    // explicit empty option the trigger would mislabel as "left" while
    // `style.textAlign` is actually unset. Browser-default flow already
    // renders text left-aligned in LTR, so empty = "let the browser /
    // SCSS decide" and the four explicit values are explicit overrides.
    kind: 'dropdown', key: 'textAlign', label: 'Text align', cssProp: 'text-align',
    options: [
      { value: '',        label: '(default)' },
      { value: 'left',    label: 'left' },
      { value: 'center',  label: 'center' },
      { value: 'right',   label: 'right' },
      { value: 'justify', label: 'justify' },
    ],
  },
  alignButton: {
    // Drives an outer wrapper DIV in DmButtonRenderer (and any future block
    // with the same need). `skipInlineEmit` keeps the value out of the
    // block's own inline-style; the renderer reads `style.alignButton`
    // directly and emits `text-align` on the wrapper.
    //
    // First option is the empty "(default)" entry — CustomDropdown's
    // trigger-label falls back to `options[0].label` when the backing
    // slot has no value, so without an explicit empty option the trigger
    // would mislabel as "left" while the block's `style.alignButton` is
    // actually unset (renderer emits nothing, SCSS default rules).
    kind: 'dropdown', key: 'alignButton', label: 'Align Button', cssProp: 'text-align',
    skipInlineEmit: true,
    options: [
      { value: '',       label: '(default)' },
      { value: 'left',   label: 'left' },
      { value: 'center', label: 'center' },
      { value: 'right',  label: 'right' },
    ],
  },
  display:      {
    kind: 'dropdown', key: 'display', label: 'Display', cssProp: 'display',
    options: [
      { value: 'block',         label: 'block' },
      { value: 'inline',        label: 'inline' },
      { value: 'inline-block',  label: 'inline-block' },
      { value: 'flex',          label: 'flex' },
      { value: 'inline-flex',   label: 'inline-flex' },
      { value: 'grid',          label: 'grid' },
      { value: 'inline-grid',   label: 'inline-grid' },
      { value: 'none',          label: 'none' },
    ],
  },
  gridGap:      { kind: 'single', key: 'gridGap',      label: 'Gap',           cssProp: 'gap',           placeholder: '0' },
  gridTemplateColumns: { kind: 'single', key: 'gridTemplateColumns', label: 'Grid columns', cssProp: 'grid-template-columns', placeholder: 'e.g. 1fr 2fr 1fr' },
  justifyItems: {
    kind: 'dropdown', key: 'justifyItems', label: 'Justify (horizontal)', cssProp: 'justify-items',
    options: [
      { value: '',        label: '(default)' },
      { value: 'start',   label: 'start' },
      { value: 'center',  label: 'center' },
      { value: 'end',     label: 'end' },
      { value: 'stretch', label: 'stretch' },
    ],
  },
  alignItems: {
    kind: 'dropdown', key: 'alignItems', label: 'Align (vertical)', cssProp: 'align-items',
    options: [
      { value: '',        label: '(default)' },
      { value: 'start',   label: 'start' },
      { value: 'center',  label: 'center' },
      { value: 'end',     label: 'end' },
      { value: 'stretch', label: 'stretch' },
    ],
  },
  // N number inputs side-by-side, one per column on the columns block.
  // CSS effect lives on the `__col` children (inline `order: N` for the
  // Default tab, @media rules for per-BP overrides) — emitted by the
  // renderer / `buildBlockColumnsCss`, NOT by `buildInlineStyle`.
  columnOrder: { kind: 'column-order', key: 'columnOrder', label: 'Order' },
  position:     {
    kind: 'dropdown', key: 'position', label: 'Position', cssProp: 'position',
    // Empty first option lets per-BP tabs revert to "inherit from Default".
    // Without it the user couldn't clear a per-BP slot that drifted away
    // from the Default value (e.g. an old `relative` lingering on the
    // desktop tab while the Default tab is set to `sticky` — the per-BP
    // emitter ships `position: relative !important` and kills sticky at
    // ≥1280px). Same `(default)` convention as textAlign/borderStyle/etc.
    options: [
      { value: '',         label: '(default)' },
      { value: 'static',   label: 'static' },
      { value: 'relative', label: 'relative' },
      { value: 'absolute', label: 'absolute' },
      { value: 'fixed',    label: 'fixed' },
      { value: 'sticky',   label: 'sticky' },
    ],
  },
  // Per-side top/right/bottom/left offsets. Empty `cssPrefix` means the
  // emitted CSS props are the side names directly (`top: <v>`, etc.) —
  // not `<prefix>-<side>`. The renderer surfaces this entry only when
  // the current `position` value is `absolute` or `sticky`.
  positionInsets: { kind: 'quad', key: 'positionInsets', label: 'Offsets', cssPrefix: '', placeholder: 'e.g. 10px' },
  zIndex:       { kind: 'single', key: 'zIndex',       label: 'Z-index',       cssProp: 'z-index',       placeholder: 'e.g. 10' },
  margin:       { kind: 'quad',   key: 'margin',       label: 'Margin',        cssPrefix: 'margin' },
  padding:      { kind: 'quad',   key: 'padding',      label: 'Padding',       cssPrefix: 'padding' },
  divider:      { kind: 'divider', key: 'divider',     label: 'Divider' },
  textShadow:   { kind: 'text-shadow', key: 'textShadow', label: 'Text shadow' },
  boxShadow:    { kind: 'single', key: 'boxShadow',    label: 'Box shadow',    cssProp: 'box-shadow',    placeholder: 'e.g. 0 4px 12px rgba(0,0,0,0.15)' },
  // Transition trio — only meaningful when `position: sticky` drives the
  // base→.is-stuck state change. Panel hides these unless position=sticky
  // (same pattern as positionInsets / gridGap visibility conditionals).
  transitionDuration:       { kind: 'single', key: 'transitionDuration', label: 'Transition duration', cssProp: 'transition-duration', placeholder: 'e.g. 300ms' },
  transitionDelay:          { kind: 'single', key: 'transitionDelay',    label: 'Transition delay',    cssProp: 'transition-delay',    placeholder: 'e.g. 0ms' },
  transitionTimingFunction: {
    kind: 'dropdown', key: 'transitionTimingFunction', label: 'Transition curve', cssProp: 'transition-timing-function',
    options: [
      { value: '',            label: '(default)' },
      { value: 'ease-in-out', label: 'ease-in-out' },
      { value: 'ease',        label: 'ease' },
      { value: 'ease-in',     label: 'ease-in' },
      { value: 'ease-out',    label: 'ease-out' },
      { value: 'linear',      label: 'linear' },
    ],
  },
  listStyleType: {
    // Surfaced only on the nav-menu `ul` sub-scope (see
    // `NAV_MENU_UL_EXTRA_GROUPS`). Empty first option keeps CustomDropdown
    // from mislabelling the trigger as the first concrete value when
    // nothing is set.
    kind: 'dropdown', key: 'listStyleType', label: 'List style', cssProp: 'list-style-type',
    options: [
      { value: '',                    label: '(default)' },
      { value: 'none',                label: 'none' },
      { value: 'disc',                label: 'disc' },
      { value: 'circle',              label: 'circle' },
      { value: 'square',              label: 'square' },
      { value: 'decimal',             label: 'decimal' },
      { value: 'decimal-leading-zero', label: 'decimal-leading-zero' },
      { value: 'lower-roman',         label: 'lower-roman' },
      { value: 'upper-roman',         label: 'upper-roman' },
      { value: 'lower-alpha',         label: 'lower-alpha' },
      { value: 'upper-alpha',         label: 'upper-alpha' },
    ],
  },
};

// ──────────────────────────────────────────────────────────────────────────
// Property groups — canonical CSS-concept partition
// ──────────────────────────────────────────────────────────────────────────

// Position + Display + grid-gap fold into one "Layout" section. The first
// row pairs position + display (two dropdowns side-by-side). positionInsets
// is a quad — needs the full row width — and gridGap is conditional, so
// both stay single below the pair.
const GROUP_LAYOUT:     PropertyGroup = { key: 'layout',     label: 'Layout',     props: [['position', 'display'], 'positionInsets', 'gridGap', 'zIndex'] };
const GROUP_SPACING:    PropertyGroup = { key: 'spacing',    label: 'Spacing',    props: ['margin', 'padding'] };
const GROUP_SIZING_FULL:PropertyGroup = { key: 'sizing',     label: 'Sizing',     props: [['width', 'height']] };
const GROUP_SIZING_W:   PropertyGroup = { key: 'sizing',     label: 'Sizing',     props: ['width'] };
// Typography now opens with a paired color + background row so the two
// most-common color slots sit side-by-side. Scopes that want background
// without typography (image / gallery / video / …) still use
// GROUP_BACKGROUND below.
const GROUP_TYPOGRAPHY: PropertyGroup = { key: 'typography', label: 'Typography', props: [['color', 'background'], 'fontFamily', ['fontSize', 'lineHeight'], ['fontWeight', 'fontStyle'], 'textDecoration', 'textShadow'] };
const GROUP_BACKGROUND: PropertyGroup = { key: 'background', label: 'Background', props: ['background'] };
const GROUP_BORDER:     PropertyGroup = { key: 'border',     label: 'Border',     props: ['borderWidth', ['borderStyle', 'borderRadius'], 'borderColor'] };
// Effects: visual effects + transition timing controls. Box-shadow lives
// here (not nested inside any sub-scope) so it's reachable on every block
// that supports effects, not only on the `.is-stuck` / `:hover` variants.
// Transition trio sits alongside since it drives base→state-class
// animations (must be on the base selector to animate bi-directionally,
// see STICKY_SUBSCOPE_GROUPS notes).
const GROUP_EFFECTS:    PropertyGroup = { key: 'effects',    label: 'Effects',    props: ['boxShadow', ['transitionDuration', 'transitionDelay'], 'transitionTimingFunction', 'divider'] };

/** Composition shorthand for prose-flow blocks (heading/text/list/links/
 *  dm-button/quote/button-cta) — typography + width sizing, no height
 *  (forcing height on text content clips silently). Background sits
 *  inside GROUP_TYPOGRAPHY (paired with color), so no separate
 *  GROUP_BACKGROUND here. */
const TEXTUAL_GROUPS: PropertyGroup[] = [GROUP_LAYOUT, GROUP_SPACING, GROUP_SIZING_W, GROUP_TYPOGRAPHY, GROUP_BORDER];

/** Standalone single-prop group used to surface `text-align` ONLY on
 *  heading + text blocks (the other TEXTUAL_GROUPS sharers have
 *  layout-driven content where the default left-align is right). */
const GROUP_TEXT_ALIGN: PropertyGroup = { key: 'text-align', label: 'Alignment', props: ['textAlign'] };

/** Button-style blocks (dm-button + button-cta) share an extended Layout
 *  group that adds `alignButton` (horizontal placement within the parent
 *  flow). Sits in the Layout section alongside position/display/
 *  positionInsets/gridGap — no separate Alignment section, mirrors the
 *  dm-button placement so the same property lands in the same slot
 *  regardless of which button block the user is editing. */
const GROUP_LAYOUT_BUTTON: PropertyGroup = { key: 'layout', label: 'Layout', props: [['position', 'display'], 'positionInsets', 'gridGap', 'alignButton', 'zIndex'] };

/** Columns block uses a slightly fattened Layout group: `gridTemplateColumns`
 *  is exposed right before `gridGap` so the user can override the preset
 *  picker's `--nospress-cols` with a raw `grid-template-columns` value
 *  (mix of `fr`, fixed widths, `minmax()`, `auto-fit`, …). */
const GROUP_LAYOUT_COLUMNS: PropertyGroup = { key: 'layout', label: 'Layout', props: [['position', 'display'], 'positionInsets', 'gridTemplateColumns', 'gridGap', 'columnOrder', ['justifyItems', 'alignItems'], 'zIndex'] };

/** Schema slice surfaced inside each link sub-scope section
 *  (Link/Visited/Hover/Focus/Active). No sizing — `<a>` elements are
 *  inline by default and sizing rarely makes sense. No effects/divider —
 *  same reasoning. Background pairs with color inside GROUP_TYPOGRAPHY. */
export const LINK_SUBSCOPE_GROUPS: PropertyGroup[] = [
  GROUP_LAYOUT, GROUP_SPACING, GROUP_TYPOGRAPHY, GROUP_BORDER,
];

/** Schema slice surfaced inside each nav-menu desktop section
 *  (ul/li). Reuses the link sub-scope group set — `<ul>` and `<li>` get
 *  the same kind of structural / typography / box styling. */
export const NAV_MENU_DESKTOP_GROUPS: PropertyGroup[] = LINK_SUBSCOPE_GROUPS;

/** Extra groups appended ONLY to the `ul` sub-scope panel — bullet
 *  marker controls that don't make sense on `<li>` or the active link
 *  selector. Sits after the standard groups, matching the bottom-of-
 *  panel placement of Effects on container blocks. */
export const NAV_MENU_UL_EXTRA_GROUPS: PropertyGroup[] = [
  { key: 'list', label: 'List', props: ['listStyleType'] },
];

/** Per-key restricted schemas for the bookmark-folder sub-scope. Each
 *  section exposes EXACTLY ONE property — the NoorNote default chrome
 *  stays intact, the user just adjusts the slot that diverged from the
 *  desired look. Wider styling is reachable via the block's main
 *  wrapper properties and the link sub-scope on the inner `<a>`. */
export const BOOKMARK_FOLDER_GROUPS: Record<BookmarkFolderKey, PropertyGroup[]> = {
  item: [{ key: 'background', label: 'Background', props: ['background'] }],
  icon: [{ key: 'typography', label: 'Color', props: ['color'] }],
  desc: [{ key: 'typography', label: 'Color', props: ['color'] }],
};

/** Per-key restricted schemas for the articles-list sub-scope.
 *  Card → background only; title → color only; meta → color only. */
export const ARTICLES_LIST_GROUPS: Record<ArticlesListKey, PropertyGroup[]> = {
  card:  [{ key: 'background', label: 'Background', props: ['background'] }],
  title: [{ key: 'typography', label: 'Color', props: ['color'] }],
  meta:  [{ key: 'typography', label: 'Color', props: ['color'] }],
};

/** Per-key restricted schemas for the portfolio sub-scope. Two slots
 *  for the inline-expanded close button: `closeBtn` is the default
 *  state, `closeBtnHover` is the hover state. Each slot exposes icon
 *  color + circle background. */
export const PORTFOLIO_GROUPS: Record<PortfolioKey, PropertyGroup[]> = {
  closeBtn: [
    { key: 'typography', label: 'Icon color', props: ['color'] },
    { key: 'background', label: 'Background',  props: ['background'] },
  ],
  closeBtnHover: [
    { key: 'typography', label: 'Icon color', props: ['color'] },
    { key: 'background', label: 'Background',  props: ['background'] },
  ],
  pageBtn: [
    { key: 'typography', label: 'Color',        props: ['color'] },
    { key: 'background', label: 'Background',   props: ['background'] },
    { key: 'border',     label: 'Border color', props: ['borderColor'] },
  ],
  pageBtnHover: [
    { key: 'typography', label: 'Color',        props: ['color'] },
    { key: 'background', label: 'Background',   props: ['background'] },
    { key: 'border',     label: 'Border color', props: ['borderColor'] },
  ],
  pageBtnActive: [
    { key: 'typography', label: 'Color',        props: ['color'] },
    { key: 'background', label: 'Background',   props: ['background'] },
    { key: 'border',     label: 'Border color', props: ['borderColor'] },
  ],
};

/** Property groups surfaced inside the card-block `:hover` sub-scope.
 *  Mirrors the typical Background / Border / Effects partition but
 *  scoped to the props that actually make sense on a hover state — no
 *  layout / spacing / typography size shifts (those would re-flow the
 *  page on mouseover). Color stays paired with background as everywhere
 *  else; box-shadow + border-radius fit the "shape of the card" feel
 *  the user is tuning. */
export const CARD_HOVER_GROUPS: PropertyGroup[] = [
  { key: 'typography', label: 'Color',      props: [['color', 'background']] },
  { key: 'border',     label: 'Border',     props: ['borderWidth', ['borderStyle', 'borderRadius'], 'borderColor'] },
  { key: 'effects',    label: 'Effects',    props: ['boxShadow'] },
];

/** Property groups surfaced inside the sticky-stuck sub-scope. Same
 *  philosophy as CARD_HOVER_GROUPS but tuned for the "header gets a
 *  drop-shadow + background tint when stuck" use case. Reduced surface:
 *  background, color, font-size (typography), padding (spacing),
 *  border + border-radius, box-shadow. Width/height/position/etc. stay
 *  out because changing geometry on .is-stuck would cause the page to
 *  jump under the user. */
export const STICKY_SUBSCOPE_GROUPS: PropertyGroup[] = [
  { key: 'typography', label: 'Color',      props: [['color', 'background'], 'fontSize'] },
  { key: 'spacing',    label: 'Spacing',    props: ['padding'] },
  { key: 'border',     label: 'Border',     props: ['borderWidth', ['borderStyle', 'borderRadius'], 'borderColor'] },
  { key: 'effects',    label: 'Effects',    props: ['boxShadow'] },
];


/** Per-key restricted schemas for the weblog sub-scope. Three slots:
 *  `note` (the `.note-card` default), `noteHover` (the `.note-card:hover`
 *  background tint), `isl` (the `.isl-action` row — color propagates via
 *  `currentColor` to all interaction icons + counts). Each exposes
 *  color + background. */
export const WEBLOG_GROUPS: Record<WeblogKey, PropertyGroup[]> = {
  note: [
    { key: 'typography', label: 'Color',      props: ['color'] },
    { key: 'background', label: 'Background', props: ['background'] },
  ],
  noteHover: [
    { key: 'typography', label: 'Color',      props: ['color'] },
    { key: 'background', label: 'Background', props: ['background'] },
  ],
  isl: [
    { key: 'typography', label: 'Color',      props: ['color'] },
    { key: 'background', label: 'Background', props: ['background'] },
  ],
  loading: [
    { key: 'typography', label: 'Color',      props: ['color'] },
  ],
  meta: [
    { key: 'typography', label: 'Color',      props: ['color'] },
  ],
  mention: [
    { key: 'background', label: 'Background', props: ['background'] },
  ],
};

/** Composition shorthand for media/sub-component containers — full
 *  sizing (width + height for hero bands, fixed-aspect boxes), no
 *  typography (text styling doesn't apply to image/video/etc.).
 *  Background stays in its own section here — no typography to merge
 *  into. */
const CONTAINER_GROUPS: PropertyGroup[] = [GROUP_LAYOUT, GROUP_SPACING, GROUP_SIZING_FULL, GROUP_BACKGROUND, GROUP_BORDER];

/**
 * Per-scope group composition. The scope key matches whatever comes
 * BEFORE the first `:` in the runtime scope string — so 'page' and
 * 'heading:<uuid>' both resolve via this map. Add new rows here when a
 * block type starts supporting style.
 *
 * Display order is the canonical group order: Spacing → Sizing →
 * Typography → Background → Border → Effects. Each scope's array is
 * already authored in that order so the renderer iterates as-is.
 */
export const STYLE_MATRIX: Record<string, PropertyGroup[]> = {
  // Page: everything except sizing — the page surface fills its host.
  page: [GROUP_LAYOUT, GROUP_SPACING, GROUP_TYPOGRAPHY, GROUP_BORDER],
  text:              [...TEXTUAL_GROUPS, GROUP_TEXT_ALIGN],
  list:              TEXTUAL_GROUPS,
  links:             TEXTUAL_GROUPS,
  'dm-button':       [GROUP_LAYOUT_BUTTON, GROUP_SPACING, GROUP_SIZING_W, GROUP_TYPOGRAPHY, GROUP_BORDER],
  // Divider block is restricted: only `color` from typography (no font
  // styling — there's no text to style), plus standard box edges.
  divider:           [
    GROUP_SPACING,
    { key: 'typography', label: 'Typography', props: ['color'] },
    GROUP_BORDER,
  ],
  image:             CONTAINER_GROUPS,
  gallery:           CONTAINER_GROUPS,
  embed:             CONTAINER_GROUPS,
  'bookmark-folder': CONTAINER_GROUPS,
  columns:           [GROUP_LAYOUT_COLUMNS, GROUP_SPACING, GROUP_SIZING_FULL, GROUP_BACKGROUND, GROUP_BORDER],
  'profile-card':    CONTAINER_GROUPS,
  quote:             TEXTUAL_GROUPS,
  'button-cta':      [GROUP_LAYOUT_BUTTON, GROUP_SPACING, GROUP_SIZING_W, GROUP_TYPOGRAPHY, GROUP_BORDER],
  video:             CONTAINER_GROUPS,
  audio:             CONTAINER_GROUPS,
  'articles-list':   CONTAINER_GROUPS,
  weblog:            CONTAINER_GROUPS,
  portfolio:         CONTAINER_GROUPS,
  // Nav-menu wrapper: like the textual blocks plus full sizing — the
  // menu container is positioned/sized like a media block.
  'nav-menu':        [GROUP_LAYOUT, GROUP_SPACING, GROUP_SIZING_FULL, GROUP_TYPOGRAPHY, GROUP_BORDER],
  // Nav-menu mobile drawer sub-scope is rendered through a separate
  // section-aware path (`renderMobileMenuSubScope`), not via the flat
  // matrix here — the panel is per-selector accordion sections, each
  // containing the standard groups for that selector.
  // DIV (and its HTML-tag variants header/footer/main/section/article/
  // aside/nav/fieldset) is the most permissive container — full
  // typography (users do put headings + text inside), full sizing, plus
  // the divider edge-shapes that no other block scope supports.
  div:               [GROUP_LAYOUT, GROUP_SPACING, GROUP_SIZING_FULL, GROUP_TYPOGRAPHY, GROUP_BORDER, GROUP_EFFECTS],
  // Card: same permissive container schema as div — user typically tweaks
  // margin/padding, background (to override the .nn-card var(--color-2)),
  // border-radius (the molecule defaults to $radius-pill), and effects
  // (shadow / hover lift).
  card:              [GROUP_LAYOUT, GROUP_SPACING, GROUP_SIZING_FULL, GROUP_TYPOGRAPHY, GROUP_BORDER, GROUP_EFFECTS],
  // Vendor footer (.user-site__footer) — site-wide platform-attribution
  // wrapper, fixed content, fully styleable. Same schema as textual
  // blocks plus the link sub-scope (rendered as the inner <a>). Storage
  // lives in siteSettings.vendorFooter, NOT as a regular block in the
  // page tree.
  'vendor-footer':   TEXTUAL_GROUPS,
};

// ──────────────────────────────────────────────────────────────────────────
// Mobile-menu sub-scope sections
// ──────────────────────────────────────────────────────────────────────────

export const MOBILE_MENU_SECTIONS: MobileMenuSectionDef[] = [
  // Drawer panel — container styling. Full sizing (drawer width is
  // user-tuneable), spacing, background, border. No typography (children
  // inherit the regular page font).
  { key: 'ul',        label: 'Drawer (ul)',           groups: [GROUP_LAYOUT, GROUP_SPACING, GROUP_SIZING_FULL, GROUP_BACKGROUND, GROUP_BORDER] },
  // Item rows — list-item-level styling. Full set: spacing, sizing
  // (height for fixed-height rows), typography (per-item overrides
  // — typography already carries background as the paired first row),
  // border (separators).
  { key: 'li',        label: 'Items (li)',            groups: [GROUP_LAYOUT, GROUP_SPACING, GROUP_SIZING_FULL, GROUP_TYPOGRAPHY, GROUP_BORDER] },
  // Links — text styling primary. Spacing for hit-area padding,
  // typography (carries background paired with color), border. No sizing
  // (anchors are inline).
  { key: 'a',         label: 'Links (a)',             groups: [GROUP_LAYOUT, GROUP_SPACING, GROUP_TYPOGRAPHY, GROUP_BORDER] },
  // Active link — same prop set as `a`, just targets `<li class="active">`.
  { key: 'aActive',   label: 'Active link (a.active)', groups: [GROUP_LAYOUT, GROUP_SPACING, GROUP_TYPOGRAPHY, GROUP_BORDER] },
  // Hamburger button — color + sizing + spacing + box. No fontSize/etc
  // since it's an icon, but `color` (from typography) drives the SVG
  // currentColor stroke.
  { key: 'hamburger', label: 'Hamburger button',      groups: [GROUP_LAYOUT, GROUP_SPACING, GROUP_SIZING_FULL, GROUP_TYPOGRAPHY, GROUP_BORDER] },
  // Backdrop — just a background colour / image.
  { key: 'overlay',   label: 'Backdrop overlay',      groups: [GROUP_BACKGROUND] },
];

// ──────────────────────────────────────────────────────────────────────────
// Default-display helpers + schema resolvers
// ──────────────────────────────────────────────────────────────────────────

/** Strip the disambiguator (e.g. block UUID) from a runtime scope. */
function matrixKey(scope: string): string {
  const colon = scope.indexOf(':');
  return colon < 0 ? scope : scope.slice(0, colon);
}

/** Natural CSS `display` value per block scope — used to pre-fill the
 *  Display dropdown so the user always sees what the element actually
 *  renders as before they pick an explicit override. */
export const BLOCK_DEFAULT_DISPLAY: Record<string, string> = {
  page:              'block',
  heading:           'block',
  text:              'block',
  list:              'block',
  links:             'block',
  divider:           'block',
  image:             'block',
  gallery:           'block',
  embed:             'block',
  'bookmark-folder': 'block',
  columns:           'grid',
  'profile-card':    'block',
  quote:             'block',
  'button-cta':      'inline-block',
  'dm-button':       'inline-block',
  video:             'block',
  audio:             'block',
  'articles-list':   'block',
  weblog:            'block',
  div:               'block',
  card:              'block',
  'nav-menu':        'block',
  'vendor-footer':   'block',
  portfolio:         'block',
};

/** Same idea for the mobile-menu sub-scope, indexed by section selector
 *  (the section drives which DOM element the styles target). */
export const MOBILE_SECTION_DEFAULT_DISPLAY: Record<MobileMenuSection, string> = {
  ul:        'block',
  li:        'block',
  a:         'inline',
  aActive:   'inline',
  hamburger: 'inline-block',
  overlay:   'block',
};

/** Resolve the natural display value for a property-panel render. The
 *  scope tells us the block type; the field prefix tells us whether
 *  we're editing the wrapper (`''`) or a mobile-menu sub-section
 *  (`mobileMenu.<sec>.`). */
export function getDefaultDisplayFor(scope: string, fieldPrefix: string): string {
  if (fieldPrefix.startsWith('mobileMenu.')) {
    const sec = fieldPrefix.slice('mobileMenu.'.length).split('.')[0] as MobileMenuSection;
    return MOBILE_SECTION_DEFAULT_DISPLAY[sec] ?? '';
  }
  return BLOCK_DEFAULT_DISPLAY[matrixKey(scope)] ?? '';
}

// matrixKey is internal; exported for breakpointCss + panel renderer where
// they need the same disambiguator-stripping behaviour.
export { matrixKey };

/** Per-scope set of properties that the Properties panel SHOWS (so the
 *  user can edit them) but the wrapper-emit pipeline SKIPS (so they
 *  don't paint the block's outer element). Used today by the `portfolio`
 *  block — background should colour each card, not the wrapper that
 *  also contains the pagination bar. The matching per-element CSS is
 *  emitted by a dedicated builder in `breakpointCss.ts`. */
export const WRAPPER_SKIP_PROPS: Record<string, Set<PropertyKey>> = {
  portfolio: new Set<PropertyKey>(['background']),
  // columnOrder lives on the `__col` children, not on the columns wrapper —
  // routed through `buildBlockColumnsCss` (per-BP @media rules) and the
  // ColumnsRenderer (inline Default-tab order). Skipping it here keeps the
  // wrapper schema free of a property that has no wrapper-level effect.
  columns: new Set<PropertyKey>(['columnOrder']),
};

/** Resolve a runtime scope ('page', 'heading:<uuid>', …) to a flat
 *  schema list. Used by `buildInlineStyle` / `buildBlockBreakpointCss` /
 *  `buildImportantInlineStyle` — these don't care about grouping, only
 *  the per-property CSS mapping. Pair markers are flattened here so the
 *  CSS-emit pipeline iterates a uniform list. Properties listed in
 *  `WRAPPER_SKIP_PROPS[scope]` are removed so the wrapper inline style
 *  + per-BP wrapper CSS never carry them — they reach the public page
 *  through scope-specific builders instead. */
export function schemaFor(scope: string): PropertyEntry[] {
  const skip = WRAPPER_SKIP_PROPS[matrixKey(scope)];
  const flat = groupedSchemaFor(scope).flatMap(g =>
    g.entries.flatMap(e => (Array.isArray(e) ? e : [e])),
  );
  return skip ? flat.filter(e => !skip.has(e.key as PropertyKey)) : flat;
}

/** Resolve a runtime scope to its grouped schema. Used by
 *  `renderPropertyPanel` to emit one section header + property rows
 *  per group. Returns groups in the canonical display order as defined
 *  in `STYLE_MATRIX[scope]`. */
export function groupedSchemaFor(scope: string): ResolvedPropertyGroup[] {
  const groups = STYLE_MATRIX[matrixKey(scope)] ?? [];
  return groups.map(g => ({
    key: g.key,
    label: g.label,
    entries: resolveGroupEntries(g.props),
  }));
}

/** Resolve a `PropertyGroup.props` list to a renderer-ready
 *  `ResolvedPropertyGroup.entries` value — keeps nested arrays intact
 *  so the panel renderer can wrap them in pair grids. */
export function resolveGroupEntries(
  props: Array<PropertyKey | PropertyKey[]>,
): Array<PropertyEntry | PropertyEntry[]> {
  return props.map(k => Array.isArray(k)
    ? k.map(kk => PROPERTY_CATALOG[kk])
    : PROPERTY_CATALOG[k]);
}

/** Same source list, but flattened — used by build-side schemas
 *  (LINK_SUBSCOPE_SCHEMA / NAV_MENU_DESKTOP_SCHEMA / …) where the
 *  CSS-emit pipeline iterates one PropertyEntry at a time and doesn't
 *  care about pairing. */
export function flattenGroupProps(
  props: Array<PropertyKey | PropertyKey[]>,
): PropertyEntry[] {
  return props.flatMap(k => Array.isArray(k)
    ? k.map(kk => PROPERTY_CATALOG[kk])
    : [PROPERTY_CATALOG[k]]);
}
