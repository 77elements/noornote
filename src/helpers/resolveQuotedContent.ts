/**
 * Resolve quoted nostr references in text to readable content
 * Single purpose: Replace nostr:event/note/nevent references with truncated note content
 *
 * @param text - Raw text content containing nostr references
 * @returns Processed text with references replaced by note content
 *
 * @example
 * resolveQuotedContent("Check this out! nostr:nevent1...")
 * // => "Check this out! [This is the first line of the quoted note...]"
 */

import { extractQuotedReferences } from './extractQuotedReferences';
import { truncateNoteContent } from './truncateNoteContent';
import { QuoteOrchestrator } from '../services/orchestration/QuoteOrchestrator';

export async function resolveQuotedContent(text: string): Promise<string> {
  if (!text || text.trim() === '') {
    return text;
  }

  // Extract all quoted references
  const quotedRefs = extractQuotedReferences(text);

  if (quotedRefs.length === 0) {
    return text;
  }

  const quoteOrch = QuoteOrchestrator.getInstance();

  // Fetch all quotes in parallel
  const results = await Promise.allSettled(
    quotedRefs.map(ref => quoteOrch.fetchQuotedEvent(ref.id))
  );

  // Replace sequentially (preserves correct string positions)
  let processedText = text;
  for (let i = 0; i < quotedRefs.length; i++) {
    const ref = quotedRefs[i]!;
    const result = results[i];
    if (result && result.status === 'fulfilled' && result.value?.content) {
      const truncated = truncateNoteContent(result.value.content, 80);
      processedText = processedText.replace(ref.fullMatch, `\n[${truncated}]`);
    } else {
      processedText = processedText.replace(ref.fullMatch, '\n[Quoted note]');
    }
  }

  return processedText;
}
