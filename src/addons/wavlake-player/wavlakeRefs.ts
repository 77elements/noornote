/**
 * Wavlake track-link detection in note content.
 * Phase 1: only `wavlake.com/track/{uuid}`. Albums/playlists are out of scope.
 */

export interface WavlakeTrackRef {
  /** Track UUID. */
  id: string;
  /** Exact matched URL substring — used to strip it out of the rendered text. */
  fullMatch: string;
}

// wavlake.com/track/<uuid>, UUID = 8-4-4-4-12 hex.
export const WAVLAKE_TRACK_REGEX =
  /https?:\/\/(?:www\.)?wavlake\.com\/track\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/g;

/** Extract all wavlake track refs from text (deduped by id, original order). */
export function extractWavlakeTracks(text: string): WavlakeTrackRef[] {
  const out: WavlakeTrackRef[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(WAVLAKE_TRACK_REGEX)) {
    const id = m[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, fullMatch: m[0] });
  }
  return out;
}
