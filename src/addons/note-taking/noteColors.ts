/**
 * Note color keys. Shared by the editor (swatches) and the board (card accent).
 * The actual color values live in `_note-taking.scss` ($note-taking-colors) - keep the
 * keys here in sync with that map. 'default' = no accent (normal card border).
 */
export const NOTE_COLORS = [
  'default',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
] as const;

export type NoteColor = (typeof NOTE_COLORS)[number];

/** True if `value` is a real accent color (a known, non-default key). */
export function isAccentColor(value: string): boolean {
  return value !== 'default' && (NOTE_COLORS as readonly string[]).includes(value);
}
