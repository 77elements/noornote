/**
 * EditorStateManager
 * Shared editor interaction logic for Post/Reply modals
 *
 * Handles:
 * - Media upload insertion
 * - Emoji insertion at cursor position
 * - Post button state updates
 * - Preview rendering
 *
 * Used by: PostNoteModal, ReplyModal (and future editor modals)
 */

import { renderPostPreview } from '../../helpers/renderPostPreview';
import { ContentValidationManager } from './ContentValidationManager';
import { insertTextAtCursor } from '../../helpers/insertTextAtCursor';

export interface EditorCallbacks {
  onContentChange: (newContent: string) => void;
  onShowNSFWSwitch?: () => void;
}

export interface PreviewOptions {
  content: string;
  pubkey: string;
  isNSFW: boolean;
}

export class EditorStateManager {
  /**
   * Handle media uploaded - insert URL into textarea
   * @param url - Uploaded media URL
   * @param textareaSelector - Textarea CSS selector
   * @param callbacks - Callbacks for content changes
   */
  public static handleMediaUploaded(
    url: string,
    textareaSelector: string,
    callbacks: EditorCallbacks
  ): void {
    const textarea = document.querySelector(
      textareaSelector
    ) as HTMLTextAreaElement;
    if (!textarea) return;

    const existingText = textarea.value.trim();
    let newContent: string;

    if (existingText.length === 0) {
      newContent = url;
    } else {
      newContent = `${existingText}\n\n${url}`;
    }

    textarea.value = newContent;
    callbacks.onContentChange(newContent);

    const newPosition = newContent.length;
    textarea.setSelectionRange(newPosition, newPosition);
    textarea.focus();

    // Trigger NSFW switch display if callback provided
    if (callbacks.onShowNSFWSwitch) {
      callbacks.onShowNSFWSwitch();
    }
  }

  /**
   * Handle emoji selected - insert at cursor position
   * @param emoji - Emoji string to insert
   * @param textareaSelector - Textarea CSS selector
   * @param callbacks - Callbacks for content changes
   */
  public static handleEmojiSelected(
    emoji: string,
    textareaSelector: string,
    callbacks: EditorCallbacks
  ): void {
    const textarea = document.querySelector(
      textareaSelector
    ) as HTMLTextAreaElement;
    if (!textarea) return;
    callbacks.onContentChange(
      insertTextAtCursor(textarea, textarea.value, emoji)
    );
  }

  /**
   * Update post button state based on validation
   * @param buttonSelector - Button CSS selector
   * @param content - Current content
   * @param selectedRelays - Selected relay URLs
   * @param pollData - Optional poll data
   */
  public static updatePostButton(
    buttonSelector: string,
    content: string,
    selectedRelays: Set<string>,
    pollData?: import('../poll/PollCreator').PollData | null
  ): void {
    const postBtn = document.querySelector(buttonSelector) as HTMLButtonElement;
    if (!postBtn) return;

    const validation = ContentValidationManager.validate({
      content,
      selectedRelays,
      ...(pollData !== undefined && { pollData }),
    });
    postBtn.disabled = !validation.isValid;
  }

  /**
   * Update preview container with rendered content
   * @param previewSelector - Preview container CSS selector
   * @param options - Preview rendering options
   */
  public static updatePreview(
    previewSelector: string,
    options: PreviewOptions
  ): void {
    const previewContainer = document.querySelector(previewSelector);
    if (!previewContainer) return;

    previewContainer.innerHTML = renderPostPreview({
      content: options.content,
      pubkey: options.pubkey,
      isNSFW: options.isNSFW,
    });
  }
}
