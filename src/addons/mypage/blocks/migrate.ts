/**
 * MyPage v1 → v2 migration
 *
 * v1 stores top-level title/subtitle/description + sections[]. The
 * bookmark-folder mounts live in a SEPARATE NIP-78 event (d-tag
 * noornote/mypage-mounts) and are stored locally in MyPageMountsService.
 *
 * v2 unifies everything as a single blocks[] array:
 *   - title/subtitle/description carry over 1:1
 *   - sections[]   → n × { type: 'list', title, items } blocks
 *   - mounts[]     → n × { type: 'bookmark-folder', folderName } blocks
 *                    appended after the list-blocks
 *
 * Pure function, no side effects. Used by MypageService.getPageV2().
 */

import type { MypageListData } from '../../../services/MypageService';
import { newId, type Block, type MypagePageV2 } from './types';

export function migrateV1ToV2(v1: MypageListData, mountedFolders: string[]): MypagePageV2 {
  const blocks: Block[] = [];

  for (const section of v1.sections) {
    blocks.push({
      id: newId(),
      type: 'list',
      title: section.title,
      items: [...section.items]
    });
  }

  for (const folderName of mountedFolders) {
    if (!folderName) continue;
    blocks.push({
      id: newId(),
      type: 'bookmark-folder',
      folderName
    });
  }

  const v2: MypagePageV2 = { version: 2, blocks };
  if (v1.title?.trim()) v2.title = v1.title;
  if (v1.subtitle?.trim()) v2.subtitle = v1.subtitle;
  if (v1.description?.trim()) v2.description = v1.description;

  return v2;
}
