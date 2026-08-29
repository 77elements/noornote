import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./RelayConfig', () => ({
  RelayConfig: { getInstance: () => ({}) },
}));
vi.mock('./SystemLogger', () => ({
  SystemLogger: {
    getInstance: () => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }),
  },
}));
vi.mock('./transport/NostrTransport', () => ({
  NostrTransport: { getInstance: () => ({}) },
}));

import { FollowerCountService } from './FollowerCountService';

type CollectStub = (
  pubkey: string,
  onBatch: (
    newPubkeys: string[],
    total: number,
    relay: string | undefined
  ) => void,
  since?: number,
  forceFull?: boolean
) => Promise<string[]>;

interface TestableService {
  collectFollowers: CollectStub;
  inFlightSweeps: Map<string, unknown>;
}

const service = FollowerCountService.getInstance();
const testable = service as unknown as TestableService;

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

const tick = () => new Promise<void>(r => setTimeout(r, 5));

describe('FollowerCountService single-flight coalescing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testable.inFlightSweeps.clear();
  });

  it('concurrent getFollowerCount calls share ONE sweep, all onUpdate listeners fire', async () => {
    const PK = 'a'.repeat(64);
    const sweep = deferred<string[]>();
    const collect = vi.fn<CollectStub>((_pk, onBatch) => {
      setTimeout(() => onBatch(['f1', 'f2'], 2, 'wss://r1'), 0);
      return sweep.promise;
    });
    testable.collectFollowers = collect;

    const onUpdateA = vi.fn();
    const onUpdateB = vi.fn();
    const p1 = service.getFollowerCount(PK, onUpdateA);
    const p2 = service.getFollowerCount(PK, onUpdateB);
    await tick();
    sweep.resolve(['f1', 'f2', 'f3']);

    expect(await p1).toBe(3);
    expect(await p2).toBe(3);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(onUpdateA).toHaveBeenCalledWith(2, 'wss://r1');
    expect(onUpdateB).toHaveBeenCalledWith(2, 'wss://r1');
  });

  it('cache hit after completion bypasses the sweep entirely', async () => {
    const PK = 'b'.repeat(64);
    const collect = vi.fn((_pk, _onBatch) => Promise.resolve(['f1']));
    testable.collectFollowers = collect;

    await service.getFollowerCount(PK);
    const onUpdate = vi.fn();
    const count = await service.getFollowerCount(PK, onUpdate);

    expect(count).toBe(1);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith(1, 'cache');
  });

  it('streamFollowerList late joiner replays discovered pubkeys, no second sweep', async () => {
    const PK = 'c'.repeat(64);
    const sweep = deferred<string[]>();
    const collect = vi.fn<CollectStub>((_pk, onBatch) => {
      setTimeout(() => onBatch(['f1'], 1, 'wss://r1'), 0);
      return sweep.promise;
    });
    testable.collectFollowers = collect;

    const onBatchA = vi.fn();
    const promiseA = service.streamFollowerList(PK, onBatchA);
    await tick();

    const onBatchB = vi.fn();
    const onUpdateC = vi.fn();
    const promiseB = service.streamFollowerList(PK, onBatchB);
    const promiseC = service.getFollowerCount(PK, onUpdateC);
    await tick();

    sweep.resolve(['f1', 'f2']);
    expect(await promiseA).toEqual(['f1', 'f2']);
    expect(await promiseB).toEqual(['f1', 'f2']);
    expect(await promiseC).toBe(2);

    expect(collect).toHaveBeenCalledTimes(1);
    expect(onBatchA).toHaveBeenCalledWith(['f1']);
    expect(onBatchB).toHaveBeenCalledWith(['f1']);
    expect(onUpdateC).toHaveBeenCalledWith(1, 'wss://r1');
  });

  it('incremental (since) and forceFullRelays sweeps never coalesce', async () => {
    const PK = 'd'.repeat(64);
    const collect = vi.fn((_pk, _onBatch) => Promise.resolve(['f1']));
    testable.collectFollowers = collect;

    await service.streamFollowerList(PK, vi.fn(), { since: 123 });
    await service.streamFollowerList(PK, vi.fn(), { since: 456 });
    await service.streamFollowerList(PK, vi.fn(), { forceFullRelays: true });

    expect(collect).toHaveBeenCalledTimes(3);
  });
});
