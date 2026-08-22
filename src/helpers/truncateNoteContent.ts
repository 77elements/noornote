/**
 * Truncate note content for thread context display
 * Strips HTML, removes newlines, truncates to single line with ellipsis
 *
 * @param content - Raw note content (may contain HTML, newlines, etc.)
 * @param maxLength - Maximum character length (default: 80)
 * @returns Truncated plain text with ellipsis if needed
 *
 * @example
 * truncateNoteContent("This is a very long note that should be truncated...", 20)
 * // Returns: "This is a very long..."
 */
export function truncateNoteContent(
  content: string,
  maxLength: number = 80
): string {
  if (!content || content.trim() === '') {
    return '[Empty note]';
  }

  // Strip HTML tags
  const withoutHtml = content.replace(/<[^>]*>/g, '');

  // Replace newlines with spaces
  const singleLine = withoutHtml.replace(/\n+/g, ' ');

  // Replace multiple spaces with single space
  const normalized = singleLine.replace(/\s+/g, ' ').trim();

  if (normalized === '') {
    return '[Empty note]';
  }

  // Truncate if needed
  if (normalized.length <= maxLength) {
    return normalized;
  }

  // Find last space before maxLength to avoid cutting words
  const truncated = normalized.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');

  if (lastSpace > maxLength * 0.6) {
    // Only use last space if it's not too far back (avoid very short truncation)
    return `${truncated.slice(0, lastSpace)}...`;
  }

  return `${truncated}...`;
}
