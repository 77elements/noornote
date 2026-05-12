/**
 * Style-system barrel — re-exports the engine modules (types, catalog,
 * sanitize, build, access, divider, breakpointCss, styleWrap) AND the
 * Properties-UI from `../properties/`, so existing call sites that
 * import `from '../styles'` keep working unchanged after the split.
 *
 * New code should prefer narrow imports from the specific sub-module
 * (`./catalog`, `./build`, `../properties/panel`, …) so the bundler
 * has the best chance of tree-shaking.
 */

// Types + constants
export * from './types';

// Catalog + matrix + schema resolvers
export {
  PROPERTY_CATALOG,
  STYLE_MATRIX,
  LINK_SUBSCOPE_GROUPS,
  NAV_MENU_DESKTOP_GROUPS,
  BOOKMARK_FOLDER_GROUPS,
  ARTICLES_LIST_GROUPS,
  PORTFOLIO_GROUPS,
  MOBILE_MENU_SECTIONS,
  BLOCK_DEFAULT_DISPLAY,
  MOBILE_SECTION_DEFAULT_DISPLAY,
  getDefaultDisplayFor,
  schemaFor,
  groupedSchemaFor,
  resolveGroupEntries,
  flattenGroupProps,
  matrixKey,
} from './catalog';

// Sanitize
export { sanitizeStyleValue, sanitizeCssIdent } from './sanitize';

// Build
export {
  buildInlineStyle,
  buildImportantInlineStyle,
  migrateLegacyBorder,
} from './build';

// Access
export { readStyleField, writeStyleField } from './access';

// Divider effect
export {
  DIVIDER_CATALOG,
  DIVIDER_STYLE_OPTIONS,
  buildClipPath,
  dividerThumbSvg,
} from './divider';

// Breakpoint CSS
export {
  buildBlockBreakpointCss,
  buildBlockBookmarkFolderCss,
  buildBlockArticlesListCss,
  buildBlockNavMenuDesktopCss,
  buildBlockLinksCss,
  buildBlockPortfolioCardCss,
  buildBlockPortfolioCloseBtnCss,
  buildPageBreakpointCss,
} from './breakpointCss';

// Block wrapper
export { styleWrap } from './styleWrap';

// Properties-UI (panel + color picker)
export {
  renderPropertyPanel,
  renderColorPickerRow,
  renderPaletteSwatches,
  resolvePaletteVars,
  type RenderPropertyPanelOptions,
} from '../properties';
