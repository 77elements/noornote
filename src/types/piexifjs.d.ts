/** Minimal ambient declaration for piexifjs (no official types).
 *  Surfaces only the methods we actually use in MediaCompressionService. */
declare module 'piexifjs' {
  /** Parse a JPEG data-URL and return its EXIF / IFD blocks as objects. */
  export function load(jpegDataUrl: string): Record<string, unknown>;
  /** Serialize the IFD object set produced by `load` back to a binary
   *  EXIF segment string (suitable for `insert`). */
  export function dump(exifObj: Record<string, unknown>): string;
  /** Insert a previously-dumped EXIF segment into a JPEG data-URL. */
  export function insert(exifBin: string, jpegDataUrl: string): string;
}
