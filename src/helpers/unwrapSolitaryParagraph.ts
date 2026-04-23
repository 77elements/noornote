/**
 * If `el`'s parent is a `<p>` whose only non-whitespace content is `el` itself,
 * replace the `<p>` with `el` in place. Used by the article-rendering pipeline
 * so a nostr: reference sitting on its own line — wrapped by marked.parse into
 * `<p><span class="quote-marker"></span></p>` — ends up with the quote-box as
 * a sibling of the surrounding paragraphs rather than as an invalid
 * block-in-`<p>` child.
 */
export function unwrapSolitaryParagraph(el: Element): void {
  const parent = el.parentElement;
  if (!parent || parent.tagName !== 'P') return;

  for (const node of Array.from(parent.childNodes)) {
    if (node === el) continue;
    if (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()) continue;
    return; // other meaningful content present — leave the <p> intact
  }

  parent.replaceWith(el);
}
