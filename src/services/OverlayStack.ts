/**
 * OverlayStack - central registry of open "overlay" UI (modals, image viewer,
 * dropdowns, autocompletes, spotlight, mobile drawer ...).
 *
 * A Back action (browser/Electron back, mouse thumb button, Android hardware back)
 * should dismiss the topmost overlay and be CONSUMED there, never navigating the
 * view underneath. Every overlay registers on open and unregisters on close.
 *
 * Browser/Electron native Back is intercepted with a single same-URL history
 * "marker": pushed when the first overlay opens, it absorbs one Back press which
 * popstate turns into "close the overlay" instead of a real navigation. Closing an
 * overlay by other means (Esc / click) drops the now-stale marker again. The whole
 * marker dance is gated by one boolean (markerActive) plus one self-pop guard.
 */

interface OverlayEntry {
  id: number;
  close: () => void;
}

export interface OverlayHandle {
  id: number;
}

export class OverlayStack {
  private static stack: OverlayEntry[] = [];
  private static nextId = 1;

  /** A same-URL history marker is currently parked on top, guarding the overlay(s). */
  private static markerActive = false;
  /** We called history.back() ourselves to drop the marker; ignore that one popstate. */
  private static ignoreNextPop = false;

  /** Register an overlay. Call on open; pass the handle back to remove() on close. */
  static push(close: () => void): OverlayHandle {
    const id = this.nextId++;
    this.stack.push({ id, close });
    this.ensureMarker();
    return { id };
  }

  /** Unregister an overlay that closed by its own means (Esc / outside-click / button). */
  static remove(handle: OverlayHandle | null | undefined): void {
    if (!handle) return;
    const idx = this.stack.findIndex(o => o.id === handle.id);
    if (idx === -1) return;
    this.stack.splice(idx, 1);
    if (this.stack.length === 0) this.dropMarker();
  }

  static hasOpen(): boolean {
    return this.stack.length > 0;
  }

  /**
   * Close the topmost overlay for a DIRECT back input (mouse thumb button, Android
   * hardware back). Returns true if one was closed (consume the event).
   */
  static closeTopFromInput(): boolean {
    const top = this.stack[this.stack.length - 1];
    if (!top) return false;
    top.close(); // → remove() handles the marker cleanup
    return true;
  }

  /**
   * Handle a popstate from a native (browser/Electron) Back press. Returns true if
   * the press was absorbed (overlay dismissed, or our own marker cleanup) so the
   * Router must NOT route. Returns false for genuine navigation.
   */
  static consumeBackPopstate(): boolean {
    if (this.ignoreNextPop) {
      this.ignoreNextPop = false;
      return true;
    }
    const top = this.stack[this.stack.length - 1];
    if (!top) return false;
    // The browser already popped the marker; close without re-dropping it.
    this.markerActive = false;
    top.close();
    // More overlays still open → re-arm a marker for the next Back press.
    if (this.stack.length > 0) this.ensureMarker();
    return true;
  }

  private static ensureMarker(): void {
    if (this.markerActive) return;
    this.markerActive = true;
    window.history.pushState({ __nnOverlay: true }, '', window.location.href);
  }

  private static dropMarker(): void {
    if (!this.markerActive) return;
    this.markerActive = false;
    this.ignoreNextPop = true;
    window.history.back();
  }
}
