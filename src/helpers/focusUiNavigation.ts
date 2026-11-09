/**
 * Focus UI navigation seam — the ONE sanctioned hook between the classic
 * navigation stack and the v2 Focus Shell (sibling of focusUiSetting.ts).
 *
 * The shell registers a handler while it is mounted; ViewNavigationController
 * consults it BEFORE any classic navigation (Router / SCC tab system). If the
 * handler returns true, the view type is rendered inside the shell's focused
 * surface column instead. The handler is injected (no import from src/shell
 * here), so this file stays on the v1 side of the boundary by design.
 */

/** Returns true when the shell has rendered the view type itself. */
export type FocusNavHandler = (
  viewType: string,
  param?: string,
  event?: MouseEvent
) => boolean;

let handler: FocusNavHandler | null = null;

export function setFocusUiNavHandler(next: FocusNavHandler | null): void {
  handler = next;
}

/** Ask the shell to render this view type in its focused surface. */
export function delegateToFocusUi(
  viewType: string,
  param?: string,
  event?: MouseEvent
): boolean {
  return handler ? handler(viewType, param, event) : false;
}
