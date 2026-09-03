/**
 * Shared building blocks for the pack renderers (EmojiPack, FollowPack):
 * what-changed hint diffing against the locally cached previous version,
 * hint-DOM mounting, and the pack-card ISL mount. The card bodies (emoji
 * grid vs cover+button) deliberately stay per-renderer.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { InteractionStatusLine } from '../InteractionStatusLine';
import type { NoteUIOptions } from '../types/NoteTypes';

interface PackSnapshotBase {
  createdAt: number;
  diffLines?: string[];
}

interface PackSnapshotAccessors<TPack, TSnap extends PackSnapshotBase> {
  getSnapshot(authorPubkey: string, id: string): TSnap | null;
  setSnapshot(authorPubkey: string, id: string, snap: TSnap): void;
  snapshotFrom(pack: TPack): TSnap;
  computeDiffLines(prev: TSnap, current: TPack): string[];
}

/**
 * Build the change-description lines for a pack, diffing against the locally
 * cached previous version. First encounter falls back to the generic line;
 * same-or-older versions reuse the cached lines.
 */
export function buildPackHintLines<
  TPack extends { authorPubkey: string; id: string; createdAt: number },
  TSnap extends PackSnapshotBase,
>(
  pack: TPack,
  fallbackLine: string,
  accessors: PackSnapshotAccessors<TPack, TSnap>
): string[] {
  if (!pack.authorPubkey || !pack.id) return [];

  const prev = accessors.getSnapshot(pack.authorPubkey, pack.id);

  if (!prev) {
    accessors.setSnapshot(
      pack.authorPubkey,
      pack.id,
      accessors.snapshotFrom(pack)
    );
    return [fallbackLine];
  }

  if (pack.createdAt <= prev.createdAt) return prev.diffLines ?? [];

  const diff = accessors.computeDiffLines(prev, pack);
  const lines = diff.length > 0 ? diff : [fallbackLine];
  const snapshot = accessors.snapshotFrom(pack);
  snapshot.diffLines = lines;
  accessors.setSnapshot(pack.authorPubkey, pack.id, snapshot);
  return lines;
}

/** Mount the what-changed hint (single line vs list) onto a pack card. */
export function appendPackHint(
  element: HTMLElement,
  hintClass: string,
  lines: string[]
): void {
  if (lines.length === 0) return;

  const hint = document.createElement('div');
  hint.className = hintClass;
  if (lines.length === 1) {
    hint.textContent = lines[0]!;
  } else {
    const ul = document.createElement('ul');
    lines.forEach(line => {
      const li = document.createElement('li');
      li.textContent = line;
      ul.appendChild(li);
    });
    hint.appendChild(ul);
  }
  element.appendChild(hint);
}

/** Mount the pack card ISL (addressable-id preferred, event-id fallback). */
export function appendPackISL(
  element: HTMLElement,
  event: NostrEvent,
  noteId: string,
  opts: NoteUIOptions
): void {
  if (!noteId) return;
  const isl = new InteractionStatusLine({
    noteId,
    authorPubkey: event.pubkey,
    originalEvent: event,
    fetchStats: opts.islFetchStats || false,
    isLoggedIn: opts.isLoggedIn || false,
    ...(event.id ? { articleEventId: event.id } : {}),
  });
  element.appendChild(isl.getElement());
}
