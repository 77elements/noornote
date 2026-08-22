/**
 * Convert line breaks to <br> tags
 * Single purpose: text with \n → HTML with <br> tags
 *
 * @param text - Text content with newline characters
 * @returns HTML with \n replaced by <br>
 *
 * @example
 * convertLineBreaks("Line 1\nLine 2")
 * // => "Line 1<br>Line 2"
 */

export function convertLineBreaks(text: string): string {
  return text.replace(/\n/g, '<br>');
}
