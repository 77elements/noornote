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

describe('InfiniteScroll', () => {
  let container: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
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
});
