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
import { TypedEventBus } from '../core/TypedEventBus';
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
 * Emits `settings:focus-ui-changed` on CHANGE so listeners (e.g. MainLayout
 * gating secondary-column content) can react to both directions.
 */
export function applyFocusUi(): void {
  const enabled = isFocusUiEnabled();
  const changed =
    document.documentElement.classList.contains('ui--focus') !== enabled;
  document.documentElement.classList.toggle('ui--focus', enabled);
  if (enabled) mountFocusShell();
  else unmountFocusShell();
  if (changed) {
    TypedEventBus.getInstance().emit('settings:focus-ui-changed', { enabled });
  }
}

/**
 * Secret keyboard switch: typing `focusui` anywhere (outside inputs)
 * toggles between the classic interface and the Focus Shell — the
 * user-only path into v2 while the public UI-settings switch stays
 * hidden. Same rolling-buffer pattern as the i18n preview trigger.
 * Registered once at boot (MainLayout init).
 */
const FOCUS_UI_TRIGGER_WORD = 'focusui';

export function registerFocusUiTypedTrigger(): void {
  let buffer = '';
  document.addEventListener('keydown', event => {
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)
    ) {
      buffer = ''; // typing in a field must never accumulate the buffer
      return;
    }
    if (event.key.length !== 1) return; // ignore modifiers/Enter/arrows
    buffer = (buffer + event.key.toLowerCase()).slice(
      -FOCUS_UI_TRIGGER_WORD.length
    );
    if (buffer !== FOCUS_UI_TRIGGER_WORD) return;
    buffer = '';
    setFocusUiEnabled(!isFocusUiEnabled());
  });
}
