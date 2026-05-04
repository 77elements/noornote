/**
 * Scope user-supplied CSS to the `.user-site` host so the styles only ever
 * affect a NosPress page — never leak into the rest of the app.
 *
 * Why csstree: the rendered CSS gets PUBLISHED on relays and runs on every
 * visitor's browser. A regex-based transformer is too brittle for the edge
 * cases that show up there (commas inside `:is()`, nested `@supports`,
 * comments, escapes). csstree is an AST-based parser and we walk the tree
 * surgically.
 *
 * Transformation rules:
 *   - `body { ... }`               → `.user-site { ... }`
 *   - `body > x { ... }`           → `.user-site > x { ... }`
 *   - any other selector           → `.user-site <selector>`
 *   - `@import …`                  → DROPPED (no remote CSS loading)
 *   - `@keyframes … { 0% { … } }`  → passes through (percentages aren't selectors)
 *   - `@media`, `@supports`, etc.  → contained Rules are visited recursively
 *
 * Limits:
 *   - `MAX_LENGTH` (10 kB raw input) — anything longer is truncated.
 *   - Parse errors yield an empty string (silent, the user just sees no
 *     custom styles applied).
 */

import { parse, walk, generate, type CssNode, type Selector } from 'css-tree';

const SCOPE_CLASS = 'user-site';
const STYLE_TAG_ID = 'user-site-custom-css';
const MAX_LENGTH = 10_000;

/**
 * Transform raw user CSS into scoped CSS that can only target descendants of
 * `.user-site` (or the host itself, when the user wrote `body`).
 *
 * Returns an empty string on parse failure or on empty input.
 */
export function transformUserCss(raw: string): string {
  if (!raw) return '';
  const capped = raw.length > MAX_LENGTH ? raw.slice(0, MAX_LENGTH) : raw;

  let ast: CssNode;
  try {
    ast = parse(capped, { context: 'stylesheet', positions: false });
  } catch {
    return '';
  }

  // Drop @import entirely — published CSS must not pull remote resources.
  walk(ast, {
    visit: 'Atrule',
    enter(node, item, list) {
      if (node.name === 'import' && list && item) {
        list.remove(item);
      }
    },
  });

  // Scope every selector inside a real Rule (not @keyframes percentage rules).
  walk(ast, {
    visit: 'Rule',
    enter(node) {
      if (node.prelude.type !== 'SelectorList') return;
      for (const selector of node.prelude.children) {
        if (selector.type !== 'Selector') continue;
        scopeSelector(selector);
      }
    },
  });

  return generate(ast);
}

/**
 * Mutate a single Selector in place so it lives under `.user-site`.
 *   - If the first non-combinator part is `body`, swap it for `.user-site`.
 *   - Otherwise, prepend `.user-site` plus a descendant combinator.
 */
function scopeSelector(selector: Selector): void {
  const first = selector.children.first;

  if (first && first.type === 'TypeSelector' && first.name.toLowerCase() === 'body') {
    // Replace the leading `body` with `.user-site`. Mutate type+name in place
    // so the rest of the selector chain (combinators, classes, pseudos) is
    // preserved untouched.
    const node = first as unknown as { type: string; name: string };
    node.type = 'ClassSelector';
    node.name = SCOPE_CLASS;
    return;
  }

  // Default: descendant scope. Prepend in reverse order so the resulting list
  // is [ClassSelector(user-site), Combinator(' '), …existing].
  selector.children.prependData({ type: 'Combinator', name: ' ' });
  selector.children.prependData({ type: 'ClassSelector', name: SCOPE_CLASS });
}

/**
 * Inject (or update) a single `<style>` tag in `<head>` with the transformed
 * CSS. Idempotent — calling it twice replaces the previous content.
 */
export function applyUserCss(raw: string): void {
  const scoped = transformUserCss(raw);
  let tag = document.getElementById(STYLE_TAG_ID) as HTMLStyleElement | null;
  if (!tag) {
    tag = document.createElement('style');
    tag.id = STYLE_TAG_ID;
    document.head.appendChild(tag);
  }
  tag.textContent = scoped;
}

/** Remove the injected style tag if present. Used on view-destroy + logout. */
export function removeUserCss(): void {
  const tag = document.getElementById(STYLE_TAG_ID);
  if (tag) tag.remove();
}
