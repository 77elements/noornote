/**
 * Emoji Pack diffing — snapshots previously seen 30030 events and
 * computes human-readable change lines for the next version.
 *
 * Kind 30030 (NIP-30) is parameterizable replaceable: relays only retain
 * the newest version, so any diff has to be made against a locally cached
 * snapshot. First-time encounters fall back to "Emoji set was updated" in
 * the renderer. Mirrors src/helpers/followPackDiff.ts.
 */

import { PerAccountLocalStorage, StorageKeys } from '../services/PerAccountLocalStorage';
import type { EmojiPack, EmojiPackEmoji } from './parseEmojiPack';

export interface EmojiPackSnapshot {
  createdAt: number;
  title: string;
  emojis: string[]; // "shortcode|url" keys
  diffLines?: string[];
}

type SnapshotMap = Record<string, EmojiPackSnapshot>;

function packKey(authorPubkey: string, dTag: string): string {
  return `${authorPubkey}:${dTag}`;
}

function emojiKey(e: EmojiPackEmoji): string {
  return `${e.shortcode}|${e.url}`;
}

export function getEmojiPackSnapshot(authorPubkey: string, dTag: string): EmojiPackSnapshot | null {
  const map = PerAccountLocalStorage.getInstance().get<SnapshotMap>(StorageKeys.EMOJI_PACK_SNAPSHOTS, {});
  return map[packKey(authorPubkey, dTag)] ?? null;
}

export function setEmojiPackSnapshot(authorPubkey: string, dTag: string, snapshot: EmojiPackSnapshot): void {
  const store = PerAccountLocalStorage.getInstance();
  const map = store.get<SnapshotMap>(StorageKeys.EMOJI_PACK_SNAPSHOTS, {});
  map[packKey(authorPubkey, dTag)] = snapshot;
  store.set(StorageKeys.EMOJI_PACK_SNAPSHOTS, map);
}

export function snapshotFromEmojiPack(pack: EmojiPack): EmojiPackSnapshot {
  return {
    createdAt: pack.createdAt,
    title: pack.title,
    emojis: pack.emojis.map(emojiKey),
  };
}

export function computeEmojiPackDiffLines(prev: EmojiPackSnapshot, current: EmojiPack): string[] {
  const lines: string[] = [];

  const prevSet = new Set(prev.emojis);
  const currKeys = current.emojis.map(emojiKey);
  const currSet = new Set(currKeys);

  const added = currKeys.filter(k => !prevSet.has(k)).length;
  const removed = prev.emojis.filter(k => !currSet.has(k)).length;

  if (added === 1) lines.push('1 new emoji gif was added to this set');
  else if (added > 1) lines.push(`${added} new emoji gifs were added to this set`);

  if (removed === 1) lines.push('1 emoji gif was removed from this set');
  else if (removed > 1) lines.push(`${removed} emoji gifs were removed from this set`);

  if (prev.title !== current.title) lines.push('Title was changed');

  return lines;
}
