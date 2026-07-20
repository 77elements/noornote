/**
 * Addressable event kinds that the ArticlePreviewRenderer handles.
 *
 * Single source of truth — consumed by QuotedNoteRenderer (naddr quotes),
 * RepostRenderer (reposts of addressable events), SingleNoteView (30311 SNV
 * branch) and any future caller that needs to answer
 * "should this kind go through the article preview pipeline?".
 *
 * Any addressable kind NOT in this set must NOT be routed through the article
 * renderer — it falls into the shared UnsupportedKind fallback instead.
 */
export const ARTICLE_PREVIEW_KINDS: ReadonlySet<number> = new Set<number>([
  30023, // NIP-23 long-form article
  32267, // Zapstore app
  30311, // NIP-53 live activity / live stream
]);
