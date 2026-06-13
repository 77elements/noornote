/**
 * Splice `text` into `content` at the textarea's caret, sync the textarea, put
 * the caret after the insert, focus. Returns the new content. Shared by the
 * editors' insertAtCursor + the note/reply emoji path.
 */
export function insertTextAtCursor(textarea: HTMLTextAreaElement, content: string, text: string): string {
  const start = textarea.selectionStart;
  const newContent = content.slice(0, start) + text + content.slice(textarea.selectionEnd);
  textarea.value = newContent;

  const caret = start + text.length;
  textarea.setSelectionRange(caret, caret);
  textarea.focus();

  return newContent;
}
