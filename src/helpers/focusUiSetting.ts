/**
 * Focus UI setting — classic interface (default) vs. v2 Focus Shell.
 *
 * The Focus Shell (v2) is a separate mount layer over the existing views:
 * all primary domains are equal surfaces, one takes the central focus.
 * While it is active, the classic layout modes (default / right-pane /
 * wide / phone) have NO effect — the shell owns the layout and is
 * responsive on its own. Toggling OFF restores the classic interface
 * exactly as before.
 *
 * Gating works via the `ui--focus` class on <html> (set here) plus the
 * layout-class skip in LayoutService.applyLayoutClass() (reads the flag).
 * Toggling applies instantly — no reload.
 */

import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../services/PerAccountLocalStorage';
import { diagLog } from '../services/DiagnosticLogger';
import { mountFocusShell, unmountFocusShell } from '../shell/focusShell';

/**
 * Stored preference + session override in one read:
 * `?focusui=1` forces the Focus Shell on, `?focusui=0` forces the classic
 * interface off — both WITHOUT touching the stored flag. This is the
 * rescue hatch while the empty shell has no visible way back (and a
 * preview lever later). No URL param → the stored flag decides.
 */
export function isFocusUiEnabled(): boolean {
  if (typeof location !== 'undefined') {
    const param = new URLSearchParams(location.search).get('focusui');
    if (param === '1') return true;
    if (param === '0') return false;
  }
  return PerAccountLocalStorage.getInstance().get<boolean>(
    StorageKeys.FOCUS_UI,
    false
  );
}

export function setFocusUiEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.FOCUS_UI, enabled);
  applyFocusUi();
  diagLog('system', 'interface mode switched', {
    mode: enabled ? 'focus' : 'classic',
  });
}

/**
 * Sync the `ui--focus` gate class on <html> AND the shell mount with the
 * stored preference. Called on boot (MainLayout init) and on every toggle.
 */
export function applyFocusUi(): void {
  const enabled = isFocusUiEnabled();
  document.documentElement.classList.toggle('ui--focus', enabled);
  if (enabled) mountFocusShell();
  else unmountFocusShell();
}
