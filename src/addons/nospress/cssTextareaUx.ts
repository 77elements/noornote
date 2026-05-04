/**
 * Comfort keystroke handlers for the Custom-CSS textarea — pure DOM, no
 * library. Wired as a single delegated keydown listener on the NospressView
 * container so it survives the periodic re-renders (which replace the
 * textarea element).
 *
 * Features:
 *   - Tab               → insert 2 spaces (or indent each selected line)
 *   - Shift+Tab         → outdent
 *   - { ( [ " '         → auto-close, cursor between (or wrap selection)
 *   - } ) ]             → if the next char is already the close, skip over
 *   - Backspace         → delete an empty pair on cursor position
 *   - Enter inside `{}` → expand to multi-line, indented
 *   - Cmd/Ctrl+/        → toggle `/* … *\/` on current line or selection
 *
 * After every mutation we dispatch a synthetic `input` event so the
 * existing `handleCssEditorInput` delegation in NospressView picks up the
 * new value (silent draft save).
 */

const INDENT = '  '; // 2 spaces

const PAIRS: Record<string, string> = {
  '{': '}',
  '(': ')',
  '[': ']',
  '"': '"',
  "'": "'",
};

const CLOSERS = new Set(['}', ')', ']']);

export function bindCssTextareaUx(container: HTMLElement): void {
  container.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    if (target.tagName !== 'TEXTAREA') return;
    const ta = target as HTMLTextAreaElement;
    if (ta.dataset.cssEditor === undefined) return;

    if (e.key === 'Tab') {
      e.preventDefault();
      handleTab(ta, e.shiftKey);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    if (e.key === 'Enter') {
      if (handleSmartEnter(ta)) {
        e.preventDefault();
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return;
    }

    if (e.key === 'Backspace') {
      if (handleBackspace(ta)) {
        e.preventDefault();
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return;
    }

    if ((e.metaKey || e.ctrlKey) && e.key === '/') {
      e.preventDefault();
      handleCommentToggle(ta);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    if (e.key in PAIRS) {
      e.preventDefault();
      handleAutoClose(ta, e.key);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    if (CLOSERS.has(e.key) && handleCloseSkip(ta, e.key)) {
      e.preventDefault();
      // No input event — the value didn't change.
      return;
    }
  });
}

// ──────────────────────────────────────────────────────────────────────
// Tab / Shift+Tab — single line insert OR multi-line indent / outdent
// ──────────────────────────────────────────────────────────────────────

function handleTab(ta: HTMLTextAreaElement, outdent: boolean): void {
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const value = ta.value;
  const multiline = start !== end && value.slice(start, end).includes('\n');

  if (multiline) {
    // Operate on every line touched by the selection — boundary-snap to
    // line starts so indenting selects the full set of lines visually.
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const block = value.slice(lineStart, end);
    const newBlock = outdent
      ? block.split('\n').map(stripLeadingIndent).join('\n')
      : block.split('\n').map(line => INDENT + line).join('\n');
    ta.value = value.slice(0, lineStart) + newBlock + value.slice(end);
    ta.selectionStart = lineStart;
    ta.selectionEnd = lineStart + newBlock.length;
    return;
  }

  if (outdent) {
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const removable = leadingIndentLength(value.slice(lineStart));
    if (removable === 0) return;
    ta.value = value.slice(0, lineStart) + value.slice(lineStart + removable);
    const cursor = Math.max(lineStart, start - removable);
    ta.selectionStart = ta.selectionEnd = cursor;
    return;
  }

  ta.value = value.slice(0, start) + INDENT + value.slice(end);
  ta.selectionStart = ta.selectionEnd = start + INDENT.length;
}

function leadingIndentLength(line: string): number {
  if (line.startsWith(INDENT)) return INDENT.length;
  if (line.startsWith(' ') || line.startsWith('\t')) return 1;
  return 0;
}

function stripLeadingIndent(line: string): string {
  return line.slice(leadingIndentLength(line));
}

// ──────────────────────────────────────────────────────────────────────
// Auto-close pairs / skip closers / pair-aware backspace
// ──────────────────────────────────────────────────────────────────────

function handleAutoClose(ta: HTMLTextAreaElement, opener: string): void {
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const value = ta.value;
  const closer = PAIRS[opener]!;

  // Quote-skip: typing `"` while the next char is already `"` just steps
  // past it, so the user can close a string they're already inside.
  if ((opener === '"' || opener === "'") && value[start] === opener && start === end) {
    ta.selectionStart = ta.selectionEnd = start + 1;
    return;
  }

  if (start !== end) {
    // Wrap the selection rather than overwrite it.
    const wrapped = opener + value.slice(start, end) + closer;
    ta.value = value.slice(0, start) + wrapped + value.slice(end);
    ta.selectionStart = start + 1;
    ta.selectionEnd = end + 1;
    return;
  }

  ta.value = value.slice(0, start) + opener + closer + value.slice(start);
  ta.selectionStart = ta.selectionEnd = start + 1;
}

function handleCloseSkip(ta: HTMLTextAreaElement, key: string): boolean {
  const start = ta.selectionStart;
  if (start !== ta.selectionEnd) return false;
  if (ta.value[start] !== key) return false;
  ta.selectionStart = ta.selectionEnd = start + 1;
  return true;
}

function handleBackspace(ta: HTMLTextAreaElement): boolean {
  const start = ta.selectionStart;
  if (start !== ta.selectionEnd || start === 0) return false;
  const before = ta.value[start - 1];
  const after = ta.value[start];
  if (!before || !after) return false;
  if (PAIRS[before] === after) {
    ta.value = ta.value.slice(0, start - 1) + ta.value.slice(start + 1);
    ta.selectionStart = ta.selectionEnd = start - 1;
    return true;
  }
  return false;
}

// ──────────────────────────────────────────────────────────────────────
// Smart Enter inside `{ … }` — expand to a properly-indented block
// ──────────────────────────────────────────────────────────────────────

function handleSmartEnter(ta: HTMLTextAreaElement): boolean {
  const start = ta.selectionStart;
  if (start !== ta.selectionEnd) return false;
  const value = ta.value;
  if (value[start - 1] !== '{' || value[start] !== '}') return false;

  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const baseIndent = value.slice(lineStart).match(/^[ \t]*/)?.[0] ?? '';
  const newIndent = baseIndent + INDENT;

  const insertion = '\n' + newIndent + '\n' + baseIndent;
  ta.value = value.slice(0, start) + insertion + value.slice(start);
  ta.selectionStart = ta.selectionEnd = start + 1 + newIndent.length;
  return true;
}

// ──────────────────────────────────────────────────────────────────────
// Toggle `/* … */` comment on current line or selection
// ──────────────────────────────────────────────────────────────────────

function handleCommentToggle(ta: HTMLTextAreaElement): void {
  const selStart = ta.selectionStart;
  const selEnd = ta.selectionEnd;
  const value = ta.value;

  let chunkStart: number;
  let chunkEnd: number;
  if (selStart !== selEnd) {
    chunkStart = selStart;
    chunkEnd = selEnd;
  } else {
    chunkStart = value.lastIndexOf('\n', selStart - 1) + 1;
    const nl = value.indexOf('\n', selStart);
    chunkEnd = nl === -1 ? value.length : nl;
  }

  const chunk = value.slice(chunkStart, chunkEnd);
  const leading = chunk.match(/^\s*/)?.[0] ?? '';
  const trailing = chunk.match(/\s*$/)?.[0] ?? '';
  const inner = chunk.slice(leading.length, chunk.length - trailing.length);

  const isCommented = inner.startsWith('/*') && inner.endsWith('*/') && inner.length >= 4;
  const replacement = isCommented
    ? leading + inner.slice(2, -2).trim() + trailing
    : leading + `/* ${inner} */` + trailing;

  ta.value = value.slice(0, chunkStart) + replacement + value.slice(chunkEnd);
  ta.selectionStart = chunkStart;
  ta.selectionEnd = chunkStart + replacement.length;
}
