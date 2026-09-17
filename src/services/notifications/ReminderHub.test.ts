// @vitest-environment jsdom
/**
 * ReminderHub unit tests — Desktop/Web paths (PlatformService mocked with
 * isCapacitor=false) plus the Capacitor scheduling path via plugin mocks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockPlatform = vi.hoisted(() => ({ isCapacitor: false }));
const localNotifications = vi.hoisted(() => ({
  checkPermissions: vi.fn(async () => ({ display: 'granted' })),
  requestPermissions: vi.fn(async () => ({ display: 'granted' })),
  schedule: vi.fn(async () => {}),
  cancel: vi.fn(async () => {}),
}));
const capacitorApp = vi.hoisted(() => ({
  addListener: vi.fn(async () => ({ remove: async () => {} })),
}));

vi.mock('../PlatformService', () => ({
  PlatformService: { getInstance: () => mockPlatform },
}));
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: localNotifications,
}));
vi.mock('@capacitor/app', () => ({ App: capacitorApp }));

import { ReminderHub } from './ReminderHub';

describe('ReminderHub (Desktop/Web — isCapacitor false)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockPlatform.isCapacitor = false;
    localNotifications.schedule.mockClear();
    localNotifications.cancel.mockClear();
    ReminderHub.resetInstance();
  });
  afterEach(() => {
    vi.useRealTimers();
    ReminderHub.resetInstance();
  });

  it('idsFor returns the registered pool range', () => {
    const hub = ReminderHub.getInstance();
    hub.registerNamespace({
      name: 'test',
      idBase: 90_002_000,
      poolSize: 3,
      build: async () => [],
    });
    expect(hub.idsFor('test')).toEqual([
      { id: 90_002_000 },
      { id: 90_002_001 },
      { id: 90_002_002 },
    ]);
    expect(hub.idsFor('unknown')).toEqual([]);
  });

  it('rescheduleSoon is a no-op on Desktop (no plugin calls, no scheduling)', () => {
    const hub = ReminderHub.getInstance();
    const build = vi.fn(async () => []);
    hub.registerNamespace({ name: 'test', idBase: 1, poolSize: 1, build });
    hub.rescheduleSoon('test');
    vi.advanceTimersByTime(1000);
    expect(build).not.toHaveBeenCalled();
    expect(localNotifications.schedule).not.toHaveBeenCalled();
    expect(localNotifications.cancel).not.toHaveBeenCalled();
  });

  it('cancelNamespace clears the debounce and skips the plugin on Desktop', () => {
    const hub = ReminderHub.getInstance();
    hub.registerNamespace({
      name: 'test',
      idBase: 1,
      poolSize: 2,
      build: async () => [],
    });
    hub.rescheduleSoon('test');
    return hub.cancelNamespace('test').then(() => {
      vi.advanceTimersByTime(1000);
      expect(localNotifications.cancel).not.toHaveBeenCalled();
    });
  });

  it('osNotifyNow never fires when osWhen is "never"', async () => {
    const hub = ReminderHub.getInstance();
    await hub.osNotifyNow({ title: 't', body: 'b', osWhen: 'never' });
    expect(typeof Notification).toBe('undefined'); // node env — nothing to fire
  });

  it('fires the web notification on Desktop when permission is granted', async () => {
    const fired: { title: string; body: string }[] = [];
    vi.stubGlobal(
      'Notification',
      class {
        static permission = 'granted';
        onclick: (() => void) | null = null;
        constructor(title: string, options?: { body?: string }) {
          fired.push({ title, body: options?.body ?? '' });
        }
      }
    );
    const hub = ReminderHub.getInstance();
    await hub.osNotifyNow({ title: 'Hello', body: 'World', osWhen: 'always' });
    expect(fired).toEqual([{ title: 'Hello', body: 'World' }]);
    vi.unstubAllGlobals();
  });

  it('suppresses the web notification when focused and osWhen is "unfocused"', async () => {
    const fired: unknown[] = [];
    vi.stubGlobal(
      'Notification',
      class {
        static permission = 'granted';
        constructor() {
          fired.push(this);
        }
      }
    );
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const hub = ReminderHub.getInstance();
    await hub.osNotifyNow({ title: 't', body: 'b', osWhen: 'unfocused' });
    expect(fired).toHaveLength(0);
    vi.unstubAllGlobals();
    (document.hasFocus as ReturnType<typeof vi.spyOn>).mockRestore();
  });
});

describe('ReminderHub (Capacitor — isCapacitor true)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockPlatform.isCapacitor = true;
    localNotifications.schedule.mockClear();
    localNotifications.cancel.mockClear();
    capacitorApp.addListener.mockClear();
    ReminderHub.resetInstance();
  });
  afterEach(() => {
    vi.useRealTimers();
    ReminderHub.resetInstance();
  });

  it('schedules upcoming specs after the debounce, filtering past/out-of-pool entries', async () => {
    const hub = ReminderHub.getInstance();
    const now = Date.now();
    hub.registerNamespace({
      name: 'calendar',
      idBase: 90_002_000,
      poolSize: 4,
      build: async () => [
        { id: 90_002_000, title: 'A', body: '', fireAt: now + 60_000 },
        { id: 90_002_001, title: 'past', body: '', fireAt: now - 60_000 },
        { id: 123456, title: 'foreign id', body: '', fireAt: now + 60_000 },
        {
          id: 90_002_002,
          title: 'B',
          body: '',
          fireAt: now + 120_000,
          timeoutAfterMs: 30_000,
        },
      ],
    });
    hub.rescheduleSoon('calendar');
    await vi.advanceTimersByTimeAsync(1000);

    expect(localNotifications.cancel).toHaveBeenCalledWith({
      notifications: [
        { id: 90_002_000 },
        { id: 90_002_001 },
        { id: 90_002_002 },
        { id: 90_002_003 },
      ],
    });
    expect(localNotifications.schedule).toHaveBeenCalledTimes(1);
    const scheduled = (
      localNotifications.schedule.mock.calls[0]![0] as {
        notifications: Array<{
          id: number;
          extra?: { timeoutAfter: number };
          schedule: { allowWhileIdle: boolean };
        }>;
      }
    ).notifications;
    expect(scheduled).toHaveLength(2);
    expect(scheduled[0]!.id).toBe(90_002_000);
    expect(scheduled[1]!.id).toBe(90_002_002);
    expect(scheduled[1]!.extra?.timeoutAfter).toBe(30_000);
    expect(scheduled[1]!.schedule.allowWhileIdle).toBe(true);
  });

  it('debounces bursts into one reschedule', async () => {
    const hub = ReminderHub.getInstance();
    const build = vi.fn(async () => []);
    hub.registerNamespace({
      name: 'cal',
      idBase: 90_002_000,
      poolSize: 2,
      build,
    });
    hub.rescheduleSoon('cal');
    hub.rescheduleSoon('cal');
    hub.rescheduleSoon('cal');
    await vi.advanceTimersByTimeAsync(1000);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('arms the shared resume listener on first registration and reschedules all namespaces on resume', async () => {
    const hub = ReminderHub.getInstance();
    const buildA = vi.fn(async () => []);
    const buildB = vi.fn(async () => []);
    hub.registerNamespace({
      name: 'a',
      idBase: 90_002_000,
      poolSize: 1,
      build: buildA,
    });
    hub.registerNamespace({
      name: 'b',
      idBase: 90_003_000,
      poolSize: 1,
      build: buildB,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(capacitorApp.addListener).toHaveBeenCalledTimes(1);
    const resumeCallback = capacitorApp.addListener.mock
      .calls[0]![1] as () => void;
    buildA.mockClear();
    buildB.mockClear();
    resumeCallback();
    await vi.advanceTimersByTimeAsync(1000);
    expect(buildA).toHaveBeenCalledTimes(1);
    expect(buildB).toHaveBeenCalledTimes(1);
  });

  it('osNotifyNow schedules an immediate OS notification on Capacitor', async () => {
    const hub = ReminderHub.getInstance();
    await hub.osNotifyNow({ title: 'now', body: 'body', timeoutAfterMs: 5000 });
    expect(localNotifications.schedule).toHaveBeenCalledTimes(1);
    const scheduled = (
      localNotifications.schedule.mock.calls[0]![0] as {
        notifications: Array<{
          id: number;
          title: string;
          extra?: { timeoutAfter: number };
        }>;
      }
    ).notifications;
    expect(scheduled[0]!.title).toBe('now');
    expect(scheduled[0]!.extra?.timeoutAfter).toBe(5000);
    expect(scheduled[0]!.id).toBeGreaterThanOrEqual(99_000_000);
  });

  it('disposeNamespace cancels pending notifications and drops the pool', async () => {
    const hub = ReminderHub.getInstance();
    hub.registerNamespace({
      name: 'cal',
      idBase: 90_002_000,
      poolSize: 2,
      build: async () => [],
    });
    await hub.disposeNamespace('cal');
    expect(localNotifications.cancel).toHaveBeenCalledWith({
      notifications: [{ id: 90_002_000 }, { id: 90_002_001 }],
    });
    expect(hub.idsFor('cal')).toEqual([]);
  });
});
