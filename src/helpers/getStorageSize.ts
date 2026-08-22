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
 * console.log(`localStorage is using ${size} bytes`);
 *
 * const sessionSize = getStorageSize(sessionStorage);
 * console.log(`sessionStorage is using ${sessionSize} bytes`);
 */

export function getStorageSize(storage: Storage): number {
  let size = 0;
  try {
    for (const key in storage) {
      if (storage.hasOwnProperty(key)) {
        size += key.length + (storage[key]?.length || 0);
      }
    }
  } catch (error) {
    console.warn('Failed to calculate storage size:', error);
  }
  return size;
}
