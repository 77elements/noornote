/**
 * Paste-to-upload: when the user pastes image/video/audio file(s) into a text
 * editor, route them through the editor's own upload path (so they get the same
 * compression, progress, validation, insert and error handling as the upload
 * button) instead of pasting the raw clipboard content. Plain-text pastes are
 * left completely untouched.
 *
 * Shared by every editor that has a media uploader (New Note, Reply, Article,
 * Video, Marketplace listing, Note taking).
 *
 * @param textarea the editor's text input element
 * @param uploadFiles the editor's File[] upload entry point
 * @returns a teardown function that removes the listener
 */
export function setupPasteUpload(
  textarea: HTMLElement,
  uploadFiles: (files: File[]) => void
): () => void {
  const handler = (e: ClipboardEvent): void => {
    const files = Array.from(e.clipboardData?.files ?? []).filter(f =>
      /^(image|video|audio)\//.test(f.type)
    );
    if (files.length === 0) return; // plain text paste — leave it to the default
    e.preventDefault();
    uploadFiles(files);
  };
  textarea.addEventListener('paste', handler as EventListener);
  return () => textarea.removeEventListener('paste', handler as EventListener);
}
