/**
 * SharedRelaySocket tests — the port-backed WebSocket shim that routes NDK
 * relay connections through the relayMultiplexer SharedWorker (browser
 * socket-budget guard, Phase 2). The worker itself is thin string plumbing;
 * the protocol logic worth pinning here is the token/epoch filtering that
 * keeps stale shim generations silent.
 */

import { afterAll, describe, expect, it, vi } from 'vitest';
import { NDKRelay } from '@nostr-dev-kit/ndk';
import { installSharedRelaySockets, __testHooks } from './SharedRelaySocket';

type PortMessage = {
  type: string;
  url: string;
  token?: number;
  epoch?: number;
  state?: 'connecting' | 'open';
  data?: string;
};

class FakePort {
  public listeners: ((ev: { data: PortMessage }) => void)[] = [];
  public sent: PortMessage[] = [];

  addEventListener(_type: string, fn: (ev: { data: PortMessage }) => void) {
    this.listeners.push(fn);
  }
  removeEventListener(_type: string, fn: (ev: { data: PortMessage }) => void) {
    this.listeners = this.listeners.filter(l => l !== fn);
  }
  postMessage(msg: PortMessage) {
    this.sent.push(msg);
  }
  start() {}
  receive(msg: PortMessage) {
    this.listeners.forEach(fn => fn({ data: msg }));
  }
  clear() {
    this.sent.length = 0;
  }
  sentOf(type: string): PortMessage[] {
    return this.sent.filter(m => m.type === type);
  }
}

const fakePort = new FakePort();

vi.stubGlobal(
  'SharedWorker',
  class {
    port: FakePort;
    constructor() {
      this.port = fakePort;
    }
  }
);

/** Captured during install: the shim constructor active inside connect(). */
let lastShimCtor: (new (url: string) => object) | undefined;

// Replace NDKRelay.connect BEFORE install so install wraps this capture and
// the shim constructor is observable during the synchronous swap window.
(NDKRelay.prototype as unknown as { connect: () => void }).connect = function (
  this: unknown
) {
  lastShimCtor = (globalThis as { WebSocket?: unknown }).WebSocket as new (
    url: string
  ) => object;
};

interface ShimSocket {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  addEventListener(type: string, fn: (ev: { data: string }) => void): void;
  removeEventListener(type: string, fn: (ev: { data: string }) => void): void;
  send(data: string): void;
  close(): void;
}

/** Drives one patched NDKRelay.connect() and returns the shim it created. */
function connectShim(url = 'wss://relay.example.com'): ShimSocket {
  const proto = NDKRelay.prototype as unknown as {
    connect: (this: unknown) => unknown;
  };
  proto.connect.call({});
  const ShimCtor = lastShimCtor as new (u: string) => object;
  const socket = new ShimCtor(url) as unknown as ShimSocket;
  return socket;
}

afterAll(() => {
  vi.restoreAllMocks();
  __testHooks.resetForTests();
});

describe('SharedWorkerWebSocket (via patched NDKRelay.connect)', () => {
  installSharedRelaySockets();

  it('sends an attach request on construction and stays CONNECTING', () => {
    fakePort.clear();
    const socket = connectShim();
    expect(fakePort.sentOf('attach')).toHaveLength(1);
    expect(socket.readyState).toBe(0);
  });

  it('reaches OPEN via the attach ack and forwards sends', () => {
    fakePort.clear();
    const socket = connectShim();
    const attach = fakePort.sentOf('attach')[0];
    expect(attach).toBeDefined();
    fakePort.receive({
      type: 'attached',
      url: 'wss://relay.example.com',
      token: attach?.token,
      epoch: 3,
      state: 'open',
    });
    expect(socket.readyState).toBe(1);

    socket.send('["REQ","subid",{}]');
    const send = fakePort.sentOf('send')[0];
    expect(send?.url).toBe('wss://relay.example.com');
    expect(send?.data).toBe('["REQ","subid",{}]');
  });

  it('only accepts epoch-stamped traffic of its own generation', () => {
    fakePort.clear();
    const socket = connectShim();
    const attach = fakePort.sentOf('attach')[0];
    const onmessage = vi.fn();
    socket.onmessage = onmessage;
    fakePort.receive({
      type: 'attached',
      url: 'wss://relay.example.com',
      token: attach?.token,
      epoch: 7,
      state: 'connecting',
    });
    fakePort.receive({
      type: 'message',
      url: 'wss://relay.example.com',
      epoch: 6,
      data: '["OLD"]',
    });
    expect(onmessage).not.toHaveBeenCalled();
    fakePort.receive({
      type: 'message',
      url: 'wss://relay.example.com',
      epoch: 7,
      data: '["EVENT","subid",{}]',
    });
    expect(onmessage).toHaveBeenCalledWith({ data: '["EVENT","subid",{}]' });
  });

  it('fires onclose on socket death and ignores later traffic', () => {
    fakePort.clear();
    const socket = connectShim();
    const attach = fakePort.sentOf('attach')[0];
    const onclose = vi.fn();
    const onmessage = vi.fn();
    socket.onclose = onclose;
    socket.onmessage = onmessage;
    fakePort.receive({
      type: 'attached',
      url: 'wss://relay.example.com',
      token: attach?.token,
      epoch: 1,
      state: 'open',
    });
    fakePort.receive({
      type: 'close',
      url: 'wss://relay.example.com',
      epoch: 1,
    });
    expect(onclose).toHaveBeenCalledTimes(1);
    fakePort.receive({
      type: 'message',
      url: 'wss://relay.example.com',
      epoch: 1,
      data: 'late',
    });
    expect(onmessage).not.toHaveBeenCalled();
  });

  it('close() detaches, notifies the worker and fires a local close event', () => {
    fakePort.clear();
    const socket = connectShim();
    const onclose = vi.fn();
    socket.onclose = onclose;
    socket.close();
    expect(fakePort.sentOf('detach')).toHaveLength(1);
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(socket.readyState).toBe(3);
  });

  // Regression: NDK's keepalive probe adds a 'message' listener and removes it
  // from inside the callback. A shim without addEventListener threw here.
  it('supports addEventListener/removeEventListener for message', () => {
    fakePort.clear();
    const socket = connectShim();
    const attach = fakePort.sentOf('attach')[0];
    const seen: string[] = [];
    const probe = (ev: { data: string }) => {
      seen.push(ev.data);
      socket.removeEventListener('message', probe);
    };
    socket.addEventListener('message', probe);

    fakePort.receive({
      type: 'attached',
      url: 'wss://relay.example.com',
      token: attach?.token,
      epoch: 2,
      state: 'open',
    });
    fakePort.receive({
      type: 'message',
      url: 'wss://relay.example.com',
      epoch: 2,
      data: '["NOTICE","pong"]',
    });
    fakePort.receive({
      type: 'message',
      url: 'wss://relay.example.com',
      epoch: 2,
      data: '["NOTICE","late"]',
    });
    // Removed after the first message, so the second is not delivered.
    expect(seen).toEqual(['["NOTICE","pong"]']);
  });

  it('keeps onmessage and addEventListener delivery in sync', () => {
    fakePort.clear();
    const socket = connectShim();
    const attach = fakePort.sentOf('attach')[0];
    const viaHandler = vi.fn();
    const viaListener = vi.fn();
    socket.onmessage = viaHandler;
    socket.addEventListener('message', viaListener);
    fakePort.receive({
      type: 'attached',
      url: 'wss://relay.example.com',
      token: attach?.token,
      epoch: 5,
      state: 'open',
    });
    fakePort.receive({
      type: 'message',
      url: 'wss://relay.example.com',
      epoch: 5,
      data: '["EOSE","s"]',
    });
    expect(viaHandler).toHaveBeenCalledWith({ data: '["EOSE","s"]' });
    expect(viaListener).toHaveBeenCalledWith({ data: '["EOSE","s"]' });
  });
});
