/**
 * WebDiag - persistent diagnostic ring buffer for the WEB build.
 *
 * Why this exists: the file-based DiagnosticLogger is a no-op on Web
 * (Desktop/Capacitor only), yet the empty-ProfileView bug (#2) happens ONLY on
 * the web build — and the user typically hits it COLD, with no console open. By
 * the time they open the console, the live logs are already gone.
 *
 * This writes structured entries to a capped localStorage ring buffer AS THEY
 * HAPPEN, so the failing PV load is already recorded when the user opens the
 * console afterwards. They retrieve it with `window.__noorDiag()` and paste it.
 *
 * Self-contained and dependency-free on purpose. Never throws (logging must not
 * break the app). Global key (diagnostic app-health data, not per-user) — see the
 * multi-account-check whitelist.
 */

const KEY = 'noornote_webdiag';
const MAX_ENTRIES = 250;
const MAX_BYTES = 400_000; // keep well under the localStorage quota

function read(): unknown[] {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/**
 * Append a structured entry to the ring buffer. Stamped with an ISO timestamp.
 * Oldest entries are dropped once the count or byte budget is exceeded.
 */
export function webDiag(ev: string, data?: Record<string, unknown>): void {
  try {
    const arr = read();
    arr.push({ t: new Date().toISOString(), ev, ...(data || {}) });
    while (arr.length > MAX_ENTRIES) arr.shift();
    let s = JSON.stringify(arr);
    while (s.length > MAX_BYTES && arr.length > 1) {
      arr.shift();
      s = JSON.stringify(arr);
    }
    localStorage.setItem(KEY, s);
  } catch {
    /* logging must never throw */
  }
}

/** Return the buffer as newline-delimited JSON (one entry per line) for copy-paste. */
export function dumpWebDiag(): string {
  return read()
    .map((e) => JSON.stringify(e))
    .join('\n');
}

/** Clear the buffer. */
export function clearWebDiag(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

declare global {
  interface Window {
    __noorDiag?: () => string;
    __noorDiagClear?: () => void;
  }
}

// Expose console helpers once. After hitting the bug, the user runs
// `__noorDiag()` to print and copy the persisted buffer.
if (typeof window !== 'undefined' && !window.__noorDiag) {
  window.__noorDiag = () => {
    const s = dumpWebDiag();
    console.log(s || '(noornote webdiag: empty)');
    return s;
  };
  window.__noorDiagClear = () => {
    clearWebDiag();
    console.log('noornote webdiag: cleared');
    return undefined as unknown as void;
  };
}
