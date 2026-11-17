/**
 * Focus history sync (v2).
 *
 * Every shell navigation records a REAL history step (Router.pushUrl) so
 * the Global Back button, browser back/forward and the hardware back all
 * walk the Router's custom stack. Router fires `router:history-changed`
 * after every routed navigation — the stage listens and re-derives its
 * state from the URL (focusUrlState.parseFocusUrl).
 *
 * The one hazard is re-entrancy: pushUrl notifies SYNCHRONOUSLY, so a
 * naive listener would re-apply the state the shell is currently applying
 * (double detail creation). The guard is a synchronous flag bracketing
 * every shell-initiated URL write — during a write the listener no-ops;
 * back/forward moves (Router.back/forward, native popstate) run it.
 */

import { Router } from '../services/Router';
import { stripSccQueryParam } from './focusUrlState';

let selfNavDepth = 0;

/** Bracket a shell-initiated URL write (no history-sync re-entry). */
function runSelfNav(write: () => void): void {
  selfNavDepth++;
  try {
    write();
  } finally {
    selfNavDepth--;
  }
}

/** True while a shell-initiated URL write is in flight (listener guard). */
export function isSelfNav(): boolean {
  return selfNavDepth > 0;
}

/** Push a new history step for a shell navigation (no route resolution). */
export function pushFocusUrl(path: string): void {
  runSelfNav(() => Router.getInstance().pushUrl(stripSccQueryParam(path)));
}

/** Rewrite the current entry in place (canonicalize / restore-adjacent). */
export function replaceFocusUrl(path: string): void {
  runSelfNav(() => Router.getInstance().replaceUrl(stripSccQueryParam(path)));
}
