/**
 * Shared autocomplete plumbing for MentionAutocomplete (core) and
 * CustomEmojiAutocomplete (addon): caret-position measurement via the
 * mirror-div technique and fixed-position dropdown placement.
 *
 * The keyboard navigation switches stay per-autocomplete — their insert
 * actions and data models differ.
 */

export interface CursorCoordinates {
  left: number;
  top: number;
  height: number;
}

/**
 * Measure the caret position inside a textarea (relative to the textarea's
 * top-left) using a mirror div. `upToIndex` = character index the caret
 * measurement is for (e.g. the trigger '@' or ':' position); `triggerChar`
 * is rendered in a measuring span to get its exact box.
 */
export function measureCursorCoordinates(
  textarea: HTMLTextAreaElement,
  upToIndex: number,
  triggerChar: string
): CursorCoordinates {
  // Create mirror div with same styling as textarea
  const mirror = document.createElement('div');
  const computedStyle = window.getComputedStyle(textarea);

  // Copy all relevant styles
  [
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'letterSpacing',
    'lineHeight',
    'textTransform',
    'wordSpacing',
    'wordWrap',
    'whiteSpace',
    'padding',
    'border',
    'boxSizing',
  ].forEach(prop => {
    const value = computedStyle[prop as keyof CSSStyleDeclaration];
    if (value !== undefined) {
      mirror.style.setProperty(prop, value as string);
    }
  });

  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.style.height = 'auto';

  document.body.appendChild(mirror);

  // Insert text up to the trigger position
  mirror.textContent = textarea.value.substring(0, upToIndex);

  // Create span for the trigger character to measure position
  const triggerSpan = document.createElement('span');
  triggerSpan.textContent = triggerChar;
  mirror.appendChild(triggerSpan);

  // Get span position
  const triggerRect = triggerSpan.getBoundingClientRect();
  const mirrorRect = mirror.getBoundingClientRect();

  const left = triggerRect.left - mirrorRect.left;
  const top = triggerRect.top - mirrorRect.top;
  const height = triggerRect.height;

  // Cleanup
  document.body.removeChild(mirror);

  return { left, top, height };
}

/** Place a fixed-position dropdown right below the measured caret. */
export function positionDropdownAtCaret(
  dropdown: HTMLElement,
  textarea: HTMLTextAreaElement,
  cursorCoords: CursorCoordinates
): void {
  const textareaRect = textarea.getBoundingClientRect();

  dropdown.style.position = 'fixed';
  dropdown.style.left = `${textareaRect.left + cursorCoords.left}px`;
  dropdown.style.top = `${textareaRect.top + cursorCoords.top + cursorCoords.height + 5}px`;
  dropdown.style.zIndex = '10000';
}
