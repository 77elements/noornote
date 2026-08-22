/**
 * Render quoted references placeholder HTML
 * Single purpose: QuotedReference[] → HTML placeholder string
 * Note: Creates placeholder HTML. Actual quoted notes are rendered dynamically after DOM creation
 *
 * @param quotedReferences - Array of QuotedReference objects
 * @returns HTML string with placeholder elements
 *
 * @example
 * renderQuotedReferencesPlaceholder([{ type: 'note', id: 'note1abc...', fullMatch: '...' }])
 * // => '<div class="note-quotes"><div class="quoted-note-container">...</div></div>'
 */

export interface QuotedReference {
  type: string;
  id: string;
  fullMatch: string;
}

export function renderQuotedReferencesPlaceholder(
  quotedReferences: QuotedReference[]
): string {
  if (quotedReferences.length === 0) return '';

  const quotesHtml = quotedReferences
    .map(ref => {
      // Placeholder that will be replaced with actual fetched content
      return `
      <div class="quoted-note-container">
        <div class="quoted-note-header">
          <span class="quote-icon">💬</span>
          <span class="quote-type">Quoted ${ref.type}</span>
        </div>
        <div class="quoted-note-content">
          <div class="quoted-note-placeholder">
            <p><em>Loading quoted content...</em></p>
            <small>ID: ${ref.id.slice(0, 12)}...</small>
          </div>
        </div>
      </div>
    `;
    })
    .join('');

  return `<div class="note-quotes">${quotesHtml}</div>`;
}
