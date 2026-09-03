import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { dedupeByCoordinateWithTombstones } from './addressableDedupe';

function makeAddressable(
  kind: number,
  pubkey: string,
  dTag: string,
  createdAt: number
): NostrEvent {
  return {
    id: `${kind}-${pubkey}-${dTag}-${createdAt}`,
    kind,
    pubkey,
    created_at: createdAt,
    content: '',
    tags: [['d', dTag]],
  } as unknown as NostrEvent;
}

function makeDeletion(coordinate: string, createdAt: number): NostrEvent {
  return {
    id: `del-${coordinate}-${createdAt}`,
    kind: 5,
    pubkey: 'author',
    created_at: createdAt,
    content: '',
    tags: [['a', coordinate]],
  } as unknown as NostrEvent;
}

describe('dedupeByCoordinateWithTombstones', () => {
  const pk = 'author';
  const prefix30023 = `30023:${pk}:`;

  it('keeps only the newest version per coordinate', () => {
    const old = makeAddressable(30023, pk, 'slug-a', 1000);
    const newer = makeAddressable(30023, pk, 'slug-a', 2000);
    const result = dedupeByCoordinateWithTombstones(
      [old, newer],
      [],
      [prefix30023]
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.created_at).toBe(2000);
  });

  it('drops coordinates whose deletion is newer than the event', () => {
    const event = makeAddressable(30023, pk, 'deleted-slug', 1000);
    const del = makeDeletion(`${prefix30023}deleted-slug`, 2000);
    const result = dedupeByCoordinateWithTombstones(
      [event],
      [del],
      [prefix30023]
    );
    expect(result).toHaveLength(0);
  });

  it('keeps re-creations newer than the deletion (canonical NIP-09)', () => {
    const recreated = makeAddressable(30023, pk, 'revived', 3000);
    const del = makeDeletion(`${prefix30023}revived`, 2000);
    const result = dedupeByCoordinateWithTombstones(
      [recreated],
      [del],
      [prefix30023]
    );
    expect(result).toHaveLength(1);
  });

  it('ignores deletions outside the configured coordinate prefixes', () => {
    const event = makeAddressable(30402, pk, 'listing', 1000);
    const del = makeDeletion(`30402:${pk}:listing`, 5000);
    // Only 30023-prefix configured → the 30402 deletion must not filter
    const result = dedupeByCoordinateWithTombstones(
      [event],
      [del],
      [prefix30023]
    );
    expect(result).toHaveLength(1);
  });

  it('treats a missing d-tag as empty-string coordinate', () => {
    const a = makeAddressable(30023, pk, '', 1000);
    const b = makeAddressable(30023, pk, '', 2000);
    const result = dedupeByCoordinateWithTombstones([a, b], [], [prefix30023]);
    expect(result).toHaveLength(1);
    expect(result[0]!.created_at).toBe(2000);
  });
});
