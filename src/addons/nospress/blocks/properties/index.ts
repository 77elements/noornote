/**
 * Properties-UI barrel — Right-pane Properties-tab rendering. The
 * Properties tab is the only consumer; everything else (catalog,
 * build pipeline, breakpointCss, styleWrap) lives in `../styles/`.
 */

export {
  renderPropertyPanel,
  type RenderPropertyPanelOptions,
} from './panel';
export {
  renderColorPickerRow,
  renderPaletteSwatches,
  resolvePaletteVars,
} from './colorPicker';
