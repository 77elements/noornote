/**
 * Calculate total size of localStorage or sessionStorage
 * Single purpose: Storage → size in bytes
 * Generic: Works with any Web Storage API (localStorage, sessionStorage)
 *
 * @param storage - Storage object (localStorage or sessionStorage)
 * @returns Total size in bytes (keys + values)
 *
 * @example
 * const size = getStorageSize(localStorage);
 * console.debug(`localStorage is using ${size} bytes`);
 *
 * const sessionSize = getStorageSize(sessionStorage);
 * console.debug(`sessionStorage is using ${sessionSize} bytes`);
 */

export function getStorageSize(storage: Storage): number {
  let size = 0;
  try {
    for (const key in storage) {
      if (Object.prototype.hasOwnProperty.call(storage, key)) {
        size += key.length + (String(storage[key] ?? '')?.length || 0);
      }
    }
  } catch (error) {
    console.warn('Failed to calculate storage size:', error);
  }
  return size;
}
