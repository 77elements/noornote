/**
 * Focus Shell (v2) — the mount layer for the Focus UI.
 *
 * Built from scratch, step by step ("operation on the open heart"): the
 * shell starts as a single-column, 100%-wide wrapper. Nothing from the
 * classic interface is reused or re-mounted here — no nav, no timeline,
 * no widgets. Classic chrome is hidden by the `html.ui--focus` CSS gate
 * (styles/components/_focus-shell.scss) while the shell owns the screen.
 *
 * TEMPORARY: the shell currently hosts ONLY the Focus-UI switch so the
 * user is never locked into the empty shell. This switch moves out again
 * as soon as Settings gets its proper place inside the shell.
 *
 * Rescue hatch (dev): `?focusui=0` boots the classic interface even when
 * the flag is on (see helpers/focusUiSetting.ts).
 *
 * The shell is deliberately dependency-light: it will later host the
 * config-driven domain surfaces (docs/todos/v2-focus-ui.md).
 */

import { Switch } from '../components/ui/Switch';
import { isFocusUiEnabled, setFocusUiEnabled } from '../helpers/focusUiSetting';
import { LayoutService } from '../services/LayoutService';
import { ToastService } from '../services/ToastService';
import { TypedEventBus } from '../core/TypedEventBus';
import { _ } from '../i18n';

const SHELL_ID = 'focus-shell';

/** Mount the Focus Shell with its temporary switch (idempotent). */
export function mountFocusShell(): void {
  if (document.getElementById(SHELL_ID)) return;
  const shell = document.createElement('div');
  shell.id = SHELL_ID;
  shell.className = 'focus-shell';

  const switchBack = new Switch({
    label: _('Focus UI (v2)'),
    checked: isFocusUiEnabled(),
    onChange: checked => {
      if (!checked) {
        setFocusUiEnabled(false);
        TypedEventBus.getInstance().emit('settings:focus-ui-changed', {
          enabled: false,
        });
        // Restore the classic layout classes immediately.
        void LayoutService.getInstance().refresh();
        ToastService.show(_('Classic interface active'), 'success');
      }
    },
  });
  shell.innerHTML = switchBack.render();
  switchBack.setupEventListeners(shell);

  document.getElementById('app')?.appendChild(shell);
}

/** Remove the Focus Shell (idempotent). */
export function unmountFocusShell(): void {
  document.getElementById(SHELL_ID)?.remove();
}
