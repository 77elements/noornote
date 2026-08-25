/**
 * Global window fields NoorNote sets at boot (index.html/main.ts) before the
 * app bundle runs. Typed here so consumers don't need `(window as any)`.
 */

interface Window {
  /** Captured ?scc= param before the router strips it (restored in MainLayout). */
  __noornote_scc_param?: string;
  /** Captured relay param pre-router (deep-link handling in App.ts). */
  __noornote_relay_param?: string;
  /** Dev-console debug handles (diagnose helpers, dev builds only). */
  __MUTUAL_CHECK_DEBUG_LOG__?: Record<string, unknown>;
  __MUTUAL_CHANGE_STORAGE__?: Record<string, unknown>;
  __FOLLOWER_CHANGE_DETECTOR__?: Record<string, unknown>;
}

interface Window {
  /** File System Access API (Chromium/Electron) — absent in Firefox/Safari. */
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: { description?: string; accept: Record<string, string[]> }[];
  }) => Promise<{
    createWritable(): Promise<{
      write(data: string): Promise<void>;
      close(): Promise<void>;
    }>;
  }>;
}
