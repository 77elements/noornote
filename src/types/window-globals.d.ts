/**
 * Global window fields NoorNote sets at boot (index.html/main.ts) before the
 * app bundle runs. Typed here so consumers don't need `(window as any)`.
 */

interface Window {
  /** Captured ?scc= param before the router strips it (restored in MainLayout). */
  __noornote_scc_param?: string;
  /** Captured relay param pre-router (deep-link handling in App.ts). */
  __noornote_relay_param?: string;
}
