/**
 * Per-account Custom Block library — user-named templates of stripped
 * block trees, surfaced at the end of the Block Library catalog. Saving
 * a multi-block selection lifts its structure (no values, no styles)
 * into a reusable Apply-card; clicking Apply inserts a fresh copy at
 * the cursor with new UUIDs everywhere.
 *
 * Storage lives in PerAccountLocalStorage so each user account has its
 * own library — same Browser + Electron parity as the rest of NosPress.
 */

import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';
import { newId, type Block } from './blocks/types';

export interface NospressCustomBlock {
  id: string;
  name: string;
  blocks: Block[];
  createdAt: number;
}

export function getCustomBlocks(): NospressCustomBlock[] {
  return PerAccountLocalStorage.getInstance().get<NospressCustomBlock[]>(
    StorageKeys.NOSPRESS_CUSTOM_BLOCKS, []
  );
}

export function saveCustomBlock(name: string, blocks: Block[]): NospressCustomBlock {
  const list = getCustomBlocks();
  const entry: NospressCustomBlock = {
    id: newId(),
    name: name.trim() || 'Untitled',
    blocks,
    createdAt: Math.floor(Date.now() / 1000),
  };
  list.push(entry);
  PerAccountLocalStorage.getInstance().set(StorageKeys.NOSPRESS_CUSTOM_BLOCKS, list);
  return entry;
}

export function deleteCustomBlock(id: string): void {
  const list = getCustomBlocks().filter(cb => cb.id !== id);
  PerAccountLocalStorage.getInstance().set(StorageKeys.NOSPRESS_CUSTOM_BLOCKS, list);
}

export function findCustomBlock(id: string): NospressCustomBlock | null {
  return getCustomBlocks().find(cb => cb.id === id) ?? null;
}
