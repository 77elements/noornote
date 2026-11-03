// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockBus,
  mockToast,
  mockFollowFn,
  mockRouter,
  mockStore,
  mockCurrentPath,
} = vi.hoisted(() => {
  const handlers = new Map<string, (payload: unknown) => void>();
  const mockFollowFn = vi.fn(async () => false);
  return {
    mockBus: {
      getInstance: () => ({
        on: (name: string, fn: (payload: unknown) => void) => {
          handlers.set(name, fn);
          return `sub-${name}`;
        },
        off: vi.fn(),
      }),
      handlers,
    },
    mockToast: {
      showWithAction: vi.fn(() => 'toast-1'),
      updateMessage: vi.fn(() => true),
      dismiss: vi.fn(),
    },
    mockFollowFn,
    mockRouter: {
      getInstance: () => ({
        navigate: vi.fn(),
        getCurrentPath: () => mockCurrentPath.value,
      }),
    },
    mockCurrentPath: { value: '' },
    mockStore: {
      data: new Map<string, unknown>(),
      get: vi.fn(
        (key: string, defaultValue: unknown) =>
          mockStore.data.get(key) ?? defaultValue
      ),
      set: vi.fn((key: string, value: unknown) => {
        mockStore.data.set(key, value);
      }),
    },
  };
});

vi.mock('../../core/TypedEventBus', () => ({ TypedEventBus: mockBus }));
vi.mock('../ToastService', () => ({ ToastService: mockToast }));
vi.mock('../FollowCheckService', () => ({
  FollowCheckService: {
    getInstance: () => ({ isFollowing: mockFollowFn }),
  },
}));
vi.mock('../UserProfileService', () => ({
  UserProfileService: {
    getInstance: () => ({
      getUserProfile: vi.fn(async () => ({
        display_name: 'Alice',
        name: 'alice',
        picture: '',
      })),
    }),
  },
}));
vi.mock('../Router', () => ({ Router: mockRouter }));
vi.mock('../DiagnosticLogger', () => ({ diagLog: vi.fn() }));
vi.mock('../PerAccountLocalStorage', () => ({
  PerAccountLocalStorage: { getInstance: () => mockStore },
  StorageKeys: { DM_SPAM_MODE_UNTIL: 'noornote_dm_spam_mode_until_map' },
}));

import { DMToastNotifier } from './DMToastNotifier';
import type { DMMessage } from './DMStore';

const mkMessage = (overrides: Partial<DMMessage> = {}): DMMessage =>
  ({
    id: 'm1',
    pubkey: 'sender-a',
    content: 'hi',
    createdAt: Math.floor(Date.now() / 1000),
    conversationWith: 'sender-a',
    isMine: false,
    wrapId: 'w1',
    format: 'nip17',
    ...overrides,
  }) as DMMessage;

const emit = (name: string, payload: unknown) =>
  mockBus.handlers.get(name)!(payload);

/** Flush microtasks + timers so the async dm:new-message handler settles. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('DMToastNotifier — wasUnread read-anchor filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.data.clear();
    mockCurrentPath.value = '';
    mockFollowFn.mockImplementation(async () => false);
    DMToastNotifier.reset();
    // Instantiate (registers bus handlers) — tests assert via mockBus
    void DMToastNotifier.getInstance();
  });

  it('ignores explicitly-read arrivals (wasUnread: false) — no toast for replayed read backlog', async () => {
    emit('dm:new-message', {
      message: mkMessage(),
      conversationWith: 'sender-a',
      wasUnread: false,
    });
    await flush();

    expect(mockToast.showWithAction).not.toHaveBeenCalled();
  });

  it('toasts genuinely-unread unknown-sender arrivals (wasUnread: true)', async () => {
    emit('dm:new-message', {
      message: mkMessage(),
      conversationWith: 'sender-a',
      wasUnread: true,
    });
    await flush();

    expect(mockToast.showWithAction).toHaveBeenCalledTimes(1);
    expect(mockToast.showWithAction).toHaveBeenCalledWith(
      'New message from an unknown sender',
      'info',
      expect.anything(),
      expect.any(Number)
    );
  });

  it('keeps legacy assume-unread behavior when wasUnread is undefined', async () => {
    emit('dm:new-message', {
      message: mkMessage(),
      conversationWith: 'sender-a',
    });
    await flush();

    expect(mockToast.showWithAction).toHaveBeenCalledTimes(1);
  });

  it('counts only unread arrivals in the aggregated burst toast', async () => {
    emit('dm:new-message', {
      message: mkMessage({ conversationWith: 'sender-a', pubkey: 'sender-a' }),
      conversationWith: 'sender-a',
      wasUnread: true,
    });
    await flush();
    // Read replay must not bump the burst count.
    emit('dm:new-message', {
      message: mkMessage({
        id: 'm2',
        pubkey: 'sender-b',
        wrapId: 'w2',
        conversationWith: 'sender-b',
      }),
      conversationWith: 'sender-b',
      wasUnread: false,
    });
    await flush();
    // Second genuine unread arrival switches to the aggregated form. The
    // 1→2 boundary swaps the toast (per-conversation action → list action),
    // so the aggregate text lands on a fresh showWithAction call.
    emit('dm:new-message', {
      message: mkMessage({
        id: 'm3',
        pubkey: 'sender-c',
        wrapId: 'w3',
        conversationWith: 'sender-c',
      }),
      conversationWith: 'sender-c',
      wasUnread: true,
    });
    await flush();

    expect(mockToast.showWithAction).toHaveBeenLastCalledWith(
      '2 new messages from unknown senders',
      'info',
      expect.anything(),
      expect.any(Number)
    );
    // A third unread arrival updates the rolling toast in place.
    emit('dm:new-message', {
      message: mkMessage({
        id: 'm4',
        pubkey: 'sender-d',
        wrapId: 'w4',
        conversationWith: 'sender-d',
      }),
      conversationWith: 'sender-d',
      wasUnread: true,
    });
    await flush();
    expect(mockToast.updateMessage).toHaveBeenCalledWith(
      'toast-1',
      '3 new messages from unknown senders'
    );
  });

  it('still ignores own outgoing echoes regardless of wasUnread', async () => {
    emit('dm:new-message', {
      message: mkMessage({ isMine: true }),
      conversationWith: 'sender-a',
      wasUnread: true,
    });
    await flush();

    expect(mockToast.showWithAction).not.toHaveBeenCalled();
  });

  it('toasts followed senders on the known track with their display name (async follow gate)', async () => {
    mockFollowFn.mockResolvedValue(true);
    emit('dm:new-message', {
      message: mkMessage(),
      conversationWith: 'sender-a',
      wasUnread: true,
    });
    await flush();

    expect(mockToast.showWithAction).toHaveBeenCalledTimes(1);
    expect(mockToast.showWithAction).toHaveBeenCalledWith(
      'New message from Alice',
      'info',
      expect.anything(),
      expect.any(Number)
    );
  });

  it('does not toast for the conversation the user is currently viewing', async () => {
    mockCurrentPath.value = '/messages/sender-a';
    emit('dm:new-message', {
      message: mkMessage(),
      conversationWith: 'sender-a',
      wasUnread: true,
    });
    await flush();

    expect(mockToast.showWithAction).not.toHaveBeenCalled();
  });

  it('does not double-count a rapid same-sender burst across the async follow check', async () => {
    // Two live arrivals from the SAME sender delivered back-to-back, before
    // either handler's awaited follow check resumed — the synchronous dedup
    // reservation must keep the burst at one count contribution.
    emit('dm:new-message', {
      message: mkMessage({ id: 'm1' }),
      conversationWith: 'sender-a',
      wasUnread: true,
    });
    emit('dm:new-message', {
      message: mkMessage({ id: 'm2', wrapId: 'w2' }),
      conversationWith: 'sender-a',
      wasUnread: true,
    });
    await flush();

    expect(mockToast.showWithAction).toHaveBeenCalledTimes(1);
    expect(mockToast.showWithAction).toHaveBeenCalledWith(
      'New message from an unknown sender',
      'info',
      expect.anything(),
      expect.any(Number)
    );
  });
});

describe('DMToastNotifier — spam-attack shield', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.data.clear();
    mockCurrentPath.value = '';
    mockFollowFn.mockImplementation(async () => false);
    DMToastNotifier.reset();
    void DMToastNotifier.getInstance();
  });

  it('shows no toast while the spam mode is engaged', async () => {
    DMToastNotifier.setSpamMode(true);
    emit('dm:new-message', {
      message: mkMessage(),
      conversationWith: 'sender-a',
      wasUnread: true,
    });
    await flush();

    expect(DMToastNotifier.isSpamModeActive()).toBe(true);
    expect(mockToast.showWithAction).not.toHaveBeenCalled();
  });

  it('known senders still toast while the spam mode is engaged (shield is unknown-only)', async () => {
    DMToastNotifier.setSpamMode(true);
    mockFollowFn.mockResolvedValue(true);
    emit('dm:new-message', {
      message: mkMessage(),
      conversationWith: 'sender-a',
      wasUnread: true,
    });
    await flush();

    expect(mockToast.showWithAction).toHaveBeenCalledTimes(1);
    expect(mockToast.showWithAction).toHaveBeenCalledWith(
      'New message from Alice',
      'info',
      expect.anything(),
      expect.any(Number)
    );
  });

  it('dismisses a visible toast the moment the shield engages', async () => {
    emit('dm:new-message', {
      message: mkMessage(),
      conversationWith: 'sender-a',
      wasUnread: true,
    });
    await flush();
    expect(mockToast.showWithAction).toHaveBeenCalledTimes(1);

    DMToastNotifier.setSpamMode(true);
    expect(mockToast.dismiss).toHaveBeenCalledWith('toast-1');
  });

  it('toasts again once the persisted shield has expired', async () => {
    // Simulate a shield engaged 25 h ago → expiry lies in the past.
    mockStore.data.set(
      'noornote_dm_spam_mode_until_map',
      Date.now() - 25 * 60 * 60 * 1000
    );
    DMToastNotifier.reset();
    void DMToastNotifier.getInstance();

    expect(DMToastNotifier.isSpamModeActive()).toBe(false);
    emit('dm:new-message', {
      message: mkMessage(),
      conversationWith: 'sender-a',
      wasUnread: true,
    });
    await flush();

    expect(mockToast.showWithAction).toHaveBeenCalledTimes(1);
  });

  it('disengaging re-arms the notifier immediately', async () => {
    DMToastNotifier.setSpamMode(true);
    DMToastNotifier.setSpamMode(false);

    expect(DMToastNotifier.isSpamModeActive()).toBe(false);
    emit('dm:new-message', {
      message: mkMessage(),
      conversationWith: 'sender-a',
      wasUnread: true,
    });
    await flush();

    expect(mockToast.showWithAction).toHaveBeenCalledTimes(1);
  });
});
