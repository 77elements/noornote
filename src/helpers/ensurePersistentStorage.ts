import { diagLog } from '../services/DiagnosticLogger';

/**
 * Ask the browser / Android WebView to mark this origin's storage as PERSISTENT,
 * so IndexedDB is not silently evicted under storage pressure or WebView maintenance.
 *
 * Without this, the WebView treats IndexedDB as best-effort. Observed symptom: the NWC
 * wallet database (`noornote_secure`) vanishing after app updates while other DBs survived.
 * `persist()` moves the origin to the "persistent" bucket, which the platform won't clear
 * on its own (only an explicit user action can).
 *
 * Idempotent and non-blocking — call once at startup. Logs the outcome to the `wallet`
 * diagnostic area so we can verify on-device whether the grant actually happened.
 */
export async function ensurePersistentStorage(): Promise<void> {
  try {
    if (!navigator.storage || typeof navigator.storage.persist !== 'function') {
      diagLog('wallet', 'storage_persist_unsupported', {});
      return;
    }
    const already = await navigator.storage.persisted();
    const granted = already ? true : await navigator.storage.persist();
    diagLog('wallet', 'storage_persist', { already, granted });
  } catch (error) {
    diagLog('wallet', 'storage_persist_error', { error: String(error) });
  }
}
