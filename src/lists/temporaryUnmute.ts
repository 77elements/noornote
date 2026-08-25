/**
 * Temporary unmute state — pure module, zero dependencies.
 *
 * "Temporarily show this user" (NoteMenu) bypasses the mute filter for the
 * current session without touching the persisted mute list. Extracted from
 * lists/mutes.ts so consumers like FeedOrchestrator and tests can use it
 * without dragging the whole list/storage graph.
 *
 * BUGFIX note (2026-08-24): FeedOrchestrator previously poked
 * `(muteOrch as any).temporaryUnmutes` — a property that no longer existed
 * after the lists consolidation, so temp-unmute silently stopped working in
 * the timeline. Everyone must use THESE functions.
 */

const temporarilyUnmuted = new Set<string>();

export function temporaryUnmute(pubkey: string): void {
  temporarilyUnmuted.add(pubkey);
}

export function removeTemporaryUnmute(pubkey: string): void {
  temporarilyUnmuted.delete(pubkey);
}

export function isTemporarilyUnmuted(pubkey: string): boolean {
  return temporarilyUnmuted.has(pubkey);
}

export function clearTemporaryUnmutes(): void {
  temporarilyUnmuted.clear();
}
