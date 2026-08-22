/**
 * ContentValidationManager
 * Shared validation logic for Post/Reply modals
 *
 * Validates:
 * - Content length (trimmed)
 * - Relay selection
 * - Poll data (optional)
 *
 * Used by: PostNoteModal, ReplyModal (and future modals)
 */

export interface ValidationOptions {
  content: string;
  selectedRelays: Set<string>;
  pollData?: any | null;
}

export interface ValidationResult {
  isValid: boolean;
  hasContent: boolean;
  hasPoll: boolean;
  hasRelays: boolean;
}

export class ContentValidationManager {
  /**
   * Validate content for posting/replying
   * @param options - Content, relays, and optional poll data
   * @returns Validation result with detailed flags
   */
  public static validate(options: ValidationOptions): ValidationResult {
    const { content, selectedRelays, pollData } = options;

    const hasContent = content.trim().length > 0;
    const hasPoll = pollData !== null && pollData !== undefined;
    const hasRelays = selectedRelays.size > 0;

    // Valid if: has relays AND (has content OR has poll)
    const isValid = hasRelays && (hasContent || hasPoll);

    return {
      isValid,
      hasContent,
      hasPoll,
      hasRelays,
    };
  }

  /**
   * Check if content is empty (whitespace-only)
   * @param content - Content string to check
   * @returns True if content is empty after trimming
   */
  public static isEmpty(content: string): boolean {
    return content.trim().length === 0;
  }

  /**
   * Check if relay selection is valid
   * @param selectedRelays - Set of selected relay URLs
   * @returns True if at least one relay is selected
   */
  public static hasValidRelays(selectedRelays: Set<string>): boolean {
    return selectedRelays.size > 0;
  }
}
