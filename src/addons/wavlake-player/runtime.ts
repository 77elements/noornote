/**
 * Wavlake Player addon runtime.
 *
 * Loaded dynamically by AddonLoader only when the addon flag is ON. The static
 * imports below are the SINGLE entry point pulling the wavlake modules
 * (refs/meta/card) into their chunk. Core call sites (ContentProcessor,
 * OriginalNoteRenderer) use only `import type { WavlakePlayerRuntime }` and fetch
 * the live runtime via
 * `AddonLoader.getInstance().getRuntime<WavlakePlayerRuntime>('wavlake-player')`.
 *
 * The runtime exposes two synchronous helpers used by the (synchronous) content
 * pipeline: `extractTracks()` (used by ContentProcessor to detect + strip track
 * links) and `renderCard()` (used by OriginalNoteRenderer to append the player).
 *
 * Destroy contract: clear the metadata cache so it becomes GC-eligible and so
 * no track data leaks across account switches. Per-card IntersectionObservers
 * self-disconnect on first intersect (see WavlakeCard).
 */
import type { AddonContext, AddonRuntime } from '../AddonLoader';
import { extractWavlakeTracks, type WavlakeTrackRef } from './wavlakeRefs';
import { renderWavlakeCard } from './WavlakeCard';
import { clearWavlakeMetaCache } from './wavlakeMeta';

export class WavlakePlayerRuntime implements AddonRuntime {
  async init(_ctx: AddonContext): Promise<void> {
    // No service/listeners to wire — detection + rendering are pure functions
    // invoked on demand by the content pipeline.
  }

  async destroy(): Promise<void> {
    clearWavlakeMetaCache();
  }

  /** Sync: detect wavlake track links in note text (used by ContentProcessor). */
  extractTracks(text: string): WavlakeTrackRef[] {
    return extractWavlakeTracks(text);
  }

  /** Sync: build the inline player card for a track id (used by OriginalNoteRenderer). */
  renderCard(trackId: string): HTMLElement {
    return renderWavlakeCard(trackId);
  }
}

export default new WavlakePlayerRuntime();
