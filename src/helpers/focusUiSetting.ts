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
import { isDomainHidden } from '../shell/hiddenObjectsStore';
import { isBookmarksEnabled } from '../addons/bookmarks/index';
import { isTribesEnabled } from '../addons/tribes/index';
import { isCustomEmojisEnabled } from '../addons/custom-emojis/index';
import { isScheduledPostsEnabled } from '../addons/scheduled-posts/index';

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

/**
 * The APPLIED interface mode (the `ui--focus` gate class), not the
 * preference: the Router's boot URL rewrite drops query params, so a
 * `?focusui=0` deep link is invisible to a later isFocusUiEnabled() re-read
 * (it then answers from the stored flag). Consumers that must match what
 * the user actually sees — the shell-owned route handlers — read this.
 * Safe at any time: setupUI applies the class before the boot navigate.
 */
export function isFocusUiActive(): boolean {
  return document.documentElement.classList.contains('ui--focus');
}

/**
 * Hidden-objects probe (v2) — the sanctioned v1-side seam for "is this
 * focus domain hidden?" (docs/todos/hidden-objects.md). Classic machinery
 * that must stay down while a domain is hidden (e.g. DM toasts) gates
 * through here instead of importing the shell directly.
 */
export function isFocusDomainHidden(domainId: string): boolean {
  return isFocusUiActive() && isDomainHidden(domainId);
}

/**
 * Factory for the addon-affordance gates: affordances that live inside
 * OTHER surfaces (ISL actions, note-menu items, composer icons) are
 * active when the addon flag is on AND the object is not hidden in v2 —
 * a hidden object makes the feature unreachable, so its affordances
 * vanish there too (v1: addon flag only). The per-addon wrappers below
 * keep the call sites named and documented; the gate logic lives once.
 */
const addonUiGate =
  (domainId: string, isEnabled: () => boolean) => (): boolean =>
    isEnabled() && !isFocusDomainHidden(domainId);

/**
 * Bookmark affordances that live inside OTHER objects' surfaces (the ISL
 * bookmark action, the note-menu bookmark items).
 */
export const isBookmarksUiActive = addonUiGate('bookmarks', isBookmarksEnabled);

/**
 * Tribes affordances that live inside OTHER surfaces (the timeline's
 * tribe tabs + "Edit tribes" link, the note-menu tribe item). The
 * `lists/tribes` module must not even load when the object is hidden —
 * RAM principle.
 */
export const isTribesUiActive = addonUiGate('tribes', isTribesEnabled);

/**
 * Custom-emojis affordances outside the object's own surface (the
 * composer's picker pack + `:shortcode:` autocomplete). NOTE the
 * composer's ON-DEMAND paths are flag-independent by design (session
 * load while the stored preference is OFF) — those gate on the hidden
 * probe alone.
 */
export const isCustomEmojisUiActive = addonUiGate(
  'custom-emojis',
  isCustomEmojisEnabled
);

/**
 * Scheduled-posts affordances outside the object's own surface (the
 * composer's schedule icon). The v2 on-demand icon visibility is
 * flag-independent by design — there the hidden probe alone is the gate.
 */
export const isScheduledPostsUiActive = addonUiGate(
  'scheduled-posts',
  isScheduledPostsEnabled
);

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
 * Login seam: while logged out the focus flag reads as OFF (default), so
 * the classic login screen shows. After a login the flag must be re-read
 * — an account with v2 enabled lands directly in the shell, a v1 account
 * never sees it. Registered once at boot (MainLayout init, next to the
 * typed trigger).
 */
export function registerFocusUiLoginSync(): void {
  TypedEventBus.getInstance().on('user:login', () => {
    applyFocusUi();
  });
}

/**
 * Secret keyboard switch: typing `focusui` anywhere (outside inputs)
 * toggles between the classic interface and the Focus Shell — the
 * user-only path into v2 while the public UI-settings switch stays
 * hidden. Same rolling-buffer pattern as the i18n preview trigger.
 * Registered once at boot (MainLayout init).
 */
const FOCUS_UI_TRIGGER_WORD = 'focusui';

/**
 * Secret typed switch `loadmon`: opens the Load HUD (the terminal-style
 * proof widget for the hidden-objects load promise, src/shell/loadHud.ts)
 * — demo surface to show non-developers that hidden objects shed their
 * relay/addon machinery live. Dynamic import keeps the widget out of the
 * boot path entirely; typed again while open just refreshes it.
 */
const LOAD_HUD_TRIGGER_WORD = 'loadmon';

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
      -Math.max(FOCUS_UI_TRIGGER_WORD.length, LOAD_HUD_TRIGGER_WORD.length)
    );
    if (buffer === FOCUS_UI_TRIGGER_WORD) {
      buffer = '';
      setFocusUiEnabled(!isFocusUiEnabled());
      return;
    }
    if (buffer === LOAD_HUD_TRIGGER_WORD) {
      buffer = '';
      void import('../shell/loadHud').then(m => m.openLoadHud());
    }
  });
}
