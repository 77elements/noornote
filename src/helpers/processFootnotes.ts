/**
 * Pre-process Pandoc-style footnotes in markdown.
 *
 * Input markdown:
 *   Some text[^1] with a footnote.
 *
 *   [^1]: Definition text.
 *
 * Returns:
 *   bodyMd       — markdown with refs replaced by <sup> HTML, definitions removed
 *   footnotesHtml — rendered <section class="footnotes">…</section> to append post-parse
 *
 * Numbering follows first-reference order. Definitions without a matching
 * reference are dropped; references without a definition are kept verbatim.
 * Footnote content supports inline markdown (bold, italic, links) via
 * marked.parseInline.
 */

import { marked } from 'marked';

export function processFootnotes(markdown: string): {
  bodyMd: string;
  footnotesHtml: string;
} {
  const defs = new Map<string, string>();

  // Extract definitions: [^id]: content (supports indented continuation lines)
  const defPattern = /^\[\^([^\]]+)\]:[ \t]*([^\n]*(?:\n[ \t]+[^\n]*)*)/gm;
  const stripped = markdown.replace(defPattern, (_m, id, rawContent) => {
    defs.set(
      String(id),
      String(rawContent)
        .replace(/\n[ \t]+/g, ' ')
        .trim()
    );
    return '';
  });

  if (defs.size === 0) return { bodyMd: markdown, footnotesHtml: '' };

  // Assign numbers in reference order and replace refs with <sup> HTML
  const order = new Map<string, number>();
  let counter = 0;
  const bodyMd = stripped.replace(/\[\^([^\]]+)\]/g, (match, id) => {
    const key = String(id);
    if (!defs.has(key)) return match;
    let n = order.get(key);
    if (n === undefined) {
      counter++;
      n = counter;
      order.set(key, n);
    }
    return `<sup class="footnote-ref"><a id="fnref-${n}" href="#fn-${n}">[${n}]</a></sup>`;
  });

  if (order.size === 0) return { bodyMd: markdown, footnotesHtml: '' };

  const items: string[] = [];
  for (const [id, n] of order) {
    const rendered = marked.parseInline(defs.get(id) ?? '') as string;
    items.push(
      `<li id="fn-${n}">${rendered} <a href="#fnref-${n}" class="footnote-backref">↩</a></li>`
    );
  }

  const footnotesHtml = `<section class="footnotes"><ol>${items.join('')}</ol></section>`;

  return { bodyMd, footnotesHtml };
}
