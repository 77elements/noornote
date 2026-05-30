/**
 * Note color keys. Shared by the editor (swatches) and the board (card accent).
 * The actual color values live in `_nostr-keep.scss` ($keep-colors) - keep the
 * keys here in sync with that map. 'default' = no accent (normal card border).
 */
export const KEEP_COLORS = [
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

export type KeepColor = (typeof KEEP_COLORS)[number];

/** True if `value` is a real accent color (a known, non-default key). */
export function isAccentColor(value: string): boolean {
  return value !== 'default' && (KEEP_COLORS as readonly string[]).includes(value);
}
