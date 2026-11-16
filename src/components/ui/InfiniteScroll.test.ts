// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// jsdom ships no IntersectionObserver — minimal stub with manual trigger.
// Each observe() registers the target; tests fire callbacks explicitly.
class IOStub {
  static instances: IOStub[] = [];
  static last: IOStub | null = null;
  private targets = new Set<Element>();
  constructor(
    public cb: IntersectionObserverCallback,
    public opts?: IntersectionObserverInit
  ) {
    IOStub.instances.push(this);
    IOStub.last = this;
  }
  observe(el: Element) {
    this.targets.add(el);
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
  trigger(isIntersecting: boolean) {
    const entries = [...this.targets].map(
      target => ({ target, isIntersecting }) as IntersectionObserverEntry
    );
    this.cb(entries, this as unknown as IntersectionObserver);
  }
}
vi.stubGlobal(
  'IntersectionObserver',
  IOStub as unknown as typeof IntersectionObserver
);

import { InfiniteScroll } from './InfiniteScroll';

// Manual rAF harness: the deferred-start path (detached container) polls via
// requestAnimationFrame — deterministic flush instead of timer faking.
const rafHarness = globalThis as Record<string, unknown>;
let rafQueue: FrameRequestCallback[] = [];
const flushRaf = (): void => {
  const queue = rafQueue;
  rafQueue = [];
  queue.forEach(cb => cb(performance.now()));
};
rafHarness.requestAnimationFrame = (cb: FrameRequestCallback): number => {
  rafQueue.push(cb);
  return rafQueue.length;
};
rafHarness.cancelAnimationFrame = (id: number): void => {
  rafQueue[id - 1] = () => undefined;
};

describe('InfiniteScroll', () => {
  let container: HTMLElement;

  beforeEach(() => {
    // Fake only the debounce timers — rAF stays the manual harness above
    // (fake-timers would otherwise overwrite it and the deferred-start
    // polling would never run in tests).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    container = document.createElement('div');
    document.body.appendChild(container);
    IOStub.instances = [];
    IOStub.last = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
  });

  it('observe() creates sentinel + loading indicator inside the container', () => {
    const is = new InfiniteScroll(vi.fn(), { loadingMessage: 'Loading more…' });
    is.observe(container);

    const sentinel = container.querySelector(
      '.infinite-scroll-sentinel'
    ) as HTMLElement | null;
    const loading = container.querySelector(
      '.infinite-scroll-loading'
    ) as HTMLElement | null;
    expect(sentinel).not.toBeNull();
    expect(loading).not.toBeNull();
    expect(loading?.textContent).toContain('Loading more…');
    // indicator hidden initially, sentinel last child order sentinel → loading
    expect(loading?.style.display).toBe('none');
    expect(container.lastElementChild).toBe(loading);
    expect(loading?.previousElementSibling).toBe(sentinel);
  });

  it('showLoadingIndicator:false skips the indicator entirely', () => {
    const is = new InfiniteScroll(vi.fn(), { showLoadingIndicator: false });
    is.observe(container);
    expect(container.querySelector('.infinite-scroll-loading')).toBeNull();
  });

  it('fires onLoadMore (debounced) when the sentinel intersects', () => {
    const onLoadMore = vi.fn();
    const is = new InfiniteScroll(onLoadMore, { debounceMs: 300 });
    is.observe(container);

    IOStub.last!.trigger(true);
    expect(onLoadMore).not.toHaveBeenCalled(); // still debounced
    vi.advanceTimersByTime(300);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('debounce coalesces rapid re-triggers into ONE load', () => {
    const onLoadMore = vi.fn();
    const is = new InfiniteScroll(onLoadMore, { debounceMs: 300 });
    is.observe(container);

    IOStub.last!.trigger(true);
    vi.advanceTimersByTime(200);
    IOStub.last!.trigger(true);
    vi.advanceTimersByTime(200); // 400ms total, but timer restarted at 200
    expect(onLoadMore).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('pause() stops triggering; resume() re-arms', () => {
    // note: debounceMs 0 is falsy → constructor falls back to the 300ms default
    const onLoadMore = vi.fn();
    const is = new InfiniteScroll(onLoadMore);
    is.observe(container);

    is.pause();
    IOStub.last!.trigger(true);
    vi.advanceTimersByTime(1000);
    expect(onLoadMore).not.toHaveBeenCalled();

    is.resume();
    IOStub.last!.trigger(true);
    vi.advanceTimersByTime(1000);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('disconnect() removes sentinel + indicator from the DOM', () => {
    const is = new InfiniteScroll(vi.fn());
    is.observe(container);
    expect(container.children.length).toBe(2);

    is.disconnect();
    expect(container.children.length).toBe(0);
    expect(container.querySelector('.infinite-scroll-sentinel')).toBeNull();
    expect(container.querySelector('.infinite-scroll-loading')).toBeNull();
  });

  it('refresh() keeps sentinel before loading indicator at the container end', () => {
    const is = new InfiniteScroll(vi.fn());
    is.observe(container);
    // simulate items appended AFTER the sentinel (renderers insert before it,
    // but hand-rolled DOM edits can shuffle the order)
    const extra = document.createElement('div');
    container.appendChild(extra);

    is.refresh();
    const sentinel = container.querySelector('.infinite-scroll-sentinel')!;
    const loading = container.querySelector('.infinite-scroll-loading')!;
    expect(container.lastElementChild).toBe(loading);
    expect(sentinel.previousElementSibling).toBe(extra);
  });

  it('showLoading/hideLoading toggle the indicator visibility', () => {
    const is = new InfiniteScroll(vi.fn());
    is.observe(container);
    const loading = container.querySelector(
      '.infinite-scroll-loading'
    ) as HTMLElement;

    is.showLoading();
    expect(loading.style.display).toBe('flex');
    is.hideLoading();
    expect(loading.style.display).toBe('none');
  });

  it('re-observe() replaces the old observer and sentinel (no duplicates)', () => {
    const is = new InfiniteScroll(vi.fn());
    is.observe(container);
    is.observe(container);
    expect(
      container.querySelectorAll('.infinite-scroll-sentinel')
    ).toHaveLength(1);
    expect(container.querySelectorAll('.infinite-scroll-loading')).toHaveLength(
      1
    );
    // old stub disconnected → its trigger is a no-op; only the new one fires
    const first = IOStub.instances[0]!;
    first.trigger(true);
    vi.advanceTimersByTime(1000);
    expect(container.isConnected).toBe(true);
  });

  // ===== Regression: detached containers + clip roots (focus surfaces) =====
  // Focus surfaces render into DETACHED subtrees that the stage appends
  // afterwards. An IntersectionObserver created against a detached root never
  // re-evaluates after attachment — the list's "load more" stayed dead on
  // first boot. observe() now defers the observer until the container is
  // connected, and resolves the root lazily at that moment.

  it('creates sentinel immediately but defers the observer until attachment', () => {
    const detached = document.createElement('div'); // NOT in the document
    const is = new InfiniteScroll(vi.fn());
    is.observe(detached);

    // sentinel + indicator exist right away (renderers insert items before)
    expect(detached.querySelector('.infinite-scroll-sentinel')).not.toBeNull();
    expect(detached.querySelector('.infinite-scroll-loading')).not.toBeNull();
    // no observer while detached
    expect(IOStub.instances).toHaveLength(0);

    // attach → the next rAF poll starts the observation
    document.body.appendChild(detached);
    flushRaf();
    expect(IOStub.instances).toHaveLength(1);
  });

  it('disconnect() cancels a pending deferred start', () => {
    const detached = document.createElement('div');
    const is = new InfiniteScroll(vi.fn());
    is.observe(detached);
    is.disconnect();

    document.body.appendChild(detached);
    flushRaf();
    expect(IOStub.instances).toHaveLength(0);
    expect(detached.querySelector('.infinite-scroll-sentinel')).toBeNull();
  });

  it('resolves a lazy root when observation starts, not at observe() time', () => {
    const detached = document.createElement('div');
    const scroller = document.createElement('section');
    let resolved = 'never';
    const is = new InfiniteScroll(vi.fn());
    is.observe(detached, () => {
      resolved = 'called';
      return scroller;
    });

    // root must NOT be resolved while detached (contextual overflow rules
    // don't match on detached subtrees → wrong root)
    expect(resolved).toBe('never');

    document.body.appendChild(detached);
    flushRaf();
    expect(resolved).toBe('called');
    // the observer was created against the lazily resolved scroll container
    expect(IOStub.last!.opts?.root).toBe(scroller);
  });

  it('uses an explicitly given scroll container as the observer root', () => {
    const scroller = document.createElement('div');
    const list = document.createElement('div');
    scroller.appendChild(list);
    document.body.appendChild(scroller);

    const is = new InfiniteScroll(vi.fn());
    is.observe(list, scroller);
    expect(IOStub.last!.opts?.root).toBe(scroller);
  });
});
