/**
 * Follow Pack diffing — snapshots previously seen 39089 events and
 * computes human-readable change lines for the next version.
 *
 * Kind 39089 is parameterizable replaceable: relays only retain the
 * newest version, so any diff has to be made against a locally cached
 * snapshot. First-time encounters fall back to "Follow pack was
 * updated" in the renderer.
 */

import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../services/PerAccountLocalStorage';
import type { FollowPack } from './parseFollowPack';

export interface FollowPackSnapshot {
  createdAt: number;
  title: string;
  description: string;
  coverImage: string;
  members: string[];
  diffLines?: string[];
}

type SnapshotMap = Record<string, FollowPackSnapshot>;

function packKey(authorPubkey: string, dTag: string): string {
  return `${authorPubkey}:${dTag}`;
}

export function getFollowPackSnapshot(
  authorPubkey: string,
  dTag: string
): FollowPackSnapshot | null {
  const map = PerAccountLocalStorage.getInstance().get<SnapshotMap>(
    StorageKeys.FOLLOW_PACK_SNAPSHOTS,
    {}
  );
  return map[packKey(authorPubkey, dTag)] ?? null;
}

export function setFollowPackSnapshot(
  authorPubkey: string,
  dTag: string,
  snapshot: FollowPackSnapshot
): void {
  const store = PerAccountLocalStorage.getInstance();
  const map = store.get<SnapshotMap>(StorageKeys.FOLLOW_PACK_SNAPSHOTS, {});
  map[packKey(authorPubkey, dTag)] = snapshot;
  store.set(StorageKeys.FOLLOW_PACK_SNAPSHOTS, map);
}

export function snapshotFromPack(pack: FollowPack): FollowPackSnapshot {
  return {
    createdAt: pack.createdAt,
    title: pack.title,
    description: pack.description,
    coverImage: pack.coverImage,
    members: [...pack.userPubkeys],
  };
}

export function computeFollowPackDiffLines(
  prev: FollowPackSnapshot,
  current: FollowPack
): string[] {
  const lines: string[] = [];

  const prevSet = new Set(prev.members);
  const currSet = new Set(current.userPubkeys);

  const added = current.userPubkeys.filter(p => !prevSet.has(p)).length;
  const removed = prev.members.filter(p => !currSet.has(p)).length;

  if (added === 1) lines.push('1 new member was added to this follow pack');
  else if (added > 1)
    lines.push(`${added} new members were added to this follow pack`);

  if (removed === 1) lines.push('1 member was removed from this follow pack');
  else if (removed > 1)
    lines.push(`${removed} members were removed from this follow pack`);

  if (prev.title !== current.title) lines.push('Title was changed');
  if (prev.description !== current.description)
    lines.push('Description was changed');
  if (prev.coverImage !== current.coverImage)
    lines.push('Cover image was changed');

  return lines;
}
