/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { ProfileBlinker, TextBlinker } from './profileBlinking';

/**
 * Regression: blink timers kept running after their element left the DOM.
 * Closure-held blinkers (repost renderer) are unreachable for destroy(), so
 * the tick itself must stop the timer once the element is detached
 * (view teardown / Focus-UI switch left ~19 orphan intervals running).
 */
describe('profileBlinking self-cleanup', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('TextBlinker stops itself once its element is detached', () => {
    vi.useFakeTimers();
    const el = document.createElement('span');
    document.body.appendChild(el);
    const blinker = new TextBlinker(el);
    blinker.start('current', 'first');

    // Blinking while attached: first tick fades out…
    vi.advanceTimersByTime(2000);
    expect(el.style.opacity).toBe('0');
    // …transition swaps text and fades back in (first swap shows current).
    vi.advanceTimersByTime(300);
    expect(el.style.opacity).toBe('1');
    expect(el.textContent).toBe('current');
    // Second cycle alternates to the first-encounter text.
    vi.advanceTimersByTime(2300);
    expect(el.textContent).toBe('first');

    // Element leaves the DOM (view teardown).
    el.remove();
    vi.advanceTimersByTime(2000); // tick fires while detached → self-destroy
    expect(el.style.opacity).toBe('1'); // no fade-out on the dead element

    // No further ticks: the timer is gone.
    vi.advanceTimersByTime(10_000);
    expect(el.style.opacity).toBe('1');
    expect(el.textContent).toBe('first');
    expect(blinker.isBlinking()).toBe(false);
  });

  it('ProfileBlinker stops itself once its element is detached', () => {
    vi.useFakeTimers();
    const img = document.createElement('img');
    document.body.appendChild(img);
    const blinker = new ProfileBlinker(img);
    blinker.start('current.png', 'first.png');

    vi.advanceTimersByTime(2000);
    expect(img.style.opacity).toBe('0');
    vi.advanceTimersByTime(300);
    expect(img.style.opacity).toBe('1');
    expect(img.getAttribute('src')).toBe('current.png');
    // Second cycle alternates to the first-encounter picture.
    vi.advanceTimersByTime(2300);
    expect(img.getAttribute('src')).toBe('first.png');

    img.remove();
    vi.advanceTimersByTime(2000);
    expect(img.style.opacity).toBe('1');

    vi.advanceTimersByTime(10_000);
    expect(img.style.opacity).toBe('1');
    expect(img.getAttribute('src')).toBe('first.png');
    expect(blinker.isBlinking()).toBe(false);
  });

  it('a self-destroyed blinker can be re-armed after re-mount', () => {
    vi.useFakeTimers();
    const el = document.createElement('span');
    document.body.appendChild(el);
    const blinker = new TextBlinker(el);
    blinker.start('current', 'first');

    el.remove();
    vi.advanceTimersByTime(2000); // self-destroy while detached
    expect(blinker.isBlinking()).toBe(false);

    // Re-mounted (cache view resume) — the next profile update calls
    // start() again and blinking resumes.
    document.body.appendChild(el);
    blinker.start('current', 'first');
    expect(blinker.isBlinking()).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(el.style.opacity).toBe('0');
  });

  it('does not start blinking when either text is missing (guard intact)', () => {
    vi.useFakeTimers();
    const el = document.createElement('span');
    document.body.appendChild(el);
    const blinker = new TextBlinker(el);
    blinker.start('current', '');
    expect(blinker.isBlinking()).toBe(false);
    expect(el.textContent).toBe('current');
  });
});
