/**
 * Shared-relay-socket adapter (browser only).
 *
 * Routes NDK's relay WebSockets through the relayMultiplexer SharedWorker so
 * all tabs of the origin share ONE socket per relay — a single tab-heavy user
 * stays far under the browser's global WebSocket budget (~255 Chromium,
 * ~200 Firefox). See `src/workers/relayMultiplexer.worker.ts` for protocol.
 *
 * Mechanism: NDK's `NDKRelayConnectivity.connect()` instantiates the global
 * `WebSocket` synchronously. We wrap `NDKRelay.prototype.connect`, swap the
 * global constructor for our port-backed shim for the duration of the call,
 * and restore it afterwards. Everything NDK does on top (reconnect backoff,
 * REQ/CLOSE handling, NIP-42 AUTH, publishing) keeps working unchanged.
 *
 * Enabled only in plain browsers (multi-tab context). Electron has one
 * window and Capacitor one WebView — both keep direct sockets. Without
 * SharedWorker support the install is a no-op and NDK connects directly.
 */

import { NDKRelay } from '@nostr-dev-kit/ndk';

let nextToken = 1;

/** Message the multiplexer worker sends (see worker header). */
interface MultiplexerMsg {
  type: 'attached' | 'open' | 'message' | 'close' | 'error';
  url: string;
  token?: number;
  epoch?: number;
  state?: 'connecting' | 'open';
  data?: string;
}

/**
 * WebSocket look-alike backed by a SharedWorker channel. Implements exactly
 * the surface NDK's connectivity uses: the four on* handlers, readyState,
 * send() and close().
 */
class SharedWorkerWebSocket {
  readonly url: string;
  readyState = 0; // CONNECTING
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;

  /** Socket generation this shim is attached to (-1 = not yet acknowledged). */
  private epoch = -1;
  private token = nextToken++;
  private readonly port: MessagePort;
  private readonly listener = (ev: MessageEvent<MultiplexerMsg>): void => {
    this.handlePortMessage(ev.data);
  };

  constructor(url: string, port: MessagePort) {
    this.url = url;
    this.port = port;
    port.addEventListener('message', this.listener);
    port.postMessage({ type: 'attach', url, token: this.token });
  }

  private handlePortMessage(msg: MultiplexerMsg): void {
    if (msg.url !== this.url) return;

    if (msg.type === 'attached') {
      if (msg.token !== this.token) return;
      this.epoch = msg.epoch ?? -1;
      if (msg.state === 'open') this.markOpen();
      return;
    }

    if (msg.epoch !== this.epoch) return; // not my socket generation
    switch (msg.type) {
      case 'open':
        this.markOpen();
        break;
      case 'message':
        if (typeof msg.data === 'string') this.onmessage?.({ data: msg.data });
        break;
      case 'close':
        this.readyState = 3; // CLOSED
        this.detach();
        this.onclose?.({});
        break;
      case 'error':
        this.onerror?.({});
        break;
    }
  }

  private markOpen(): void {
    if (this.readyState === 1) return;
    this.readyState = 1;
    this.onopen?.({});
  }

  send(data: string): void {
    this.port.postMessage({ type: 'send', url: this.url, data });
  }

  close(): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.port.postMessage({ type: 'detach', url: this.url });
    this.detach();
    // Behave like a real socket: the closer gets its own close event.
    this.onclose?.({});
  }

  /** Stop listening — stale shim becomes garbage-collectable. */
  private detach(): void {
    this.port.removeEventListener('message', this.listener);
  }
}

let sharedPort: MessagePort | null = null;

/**
 * The SharedWorker's port, created lazily and kept for the page's lifetime
 * (the worker refcounts sockets per tab, so it must not be restarted).
 * Returns null when SharedWorker is unavailable — callers keep direct sockets.
 */
function getPort(): MessagePort | null {
  if (sharedPort) return sharedPort;
  if (typeof SharedWorker === 'undefined') return null;
  try {
    const worker = new SharedWorker(
      new URL('../../workers/relayMultiplexer.worker.ts', import.meta.url),
      { type: 'module' }
    );
    sharedPort = worker.port;
    sharedPort.start();
    return sharedPort;
  } catch {
    return null;
  }
}

let installed = false;

/** @internal Test-only reset of the module singletons. */
export const __testHooks = {
  resetForTests(): void {
    sharedPort = null;
    installed = false;
  },
};

/**
 * Route NDK relay connections through the SharedWorker. Idempotent; no-op on
 * platforms without SharedWorker (then NDK opens direct WebSockets).
 */
export function installSharedRelaySockets(): void {
  if (installed || typeof SharedWorker === 'undefined') return;
  if (!getPort()) return;
  installed = true;

  const proto = NDKRelay.prototype as unknown as {
    connect: (timeoutMs?: number, reconnect?: boolean) => unknown;
  };
  const originalConnect = proto.connect;

  proto.connect = function patchedConnect(
    this: unknown,
    timeoutMs?: number,
    reconnect?: boolean
  ) {
    const globalScope = globalThis as { WebSocket?: unknown };
    const previous = globalScope.WebSocket;
    const port = getPort() as MessagePort;
    // Constructor shape matching the global WebSocket: takes the relay URL,
    // returns the port-backed shim. Statics mirror the real constants.
    class Shim {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      constructor(url: string) {
        return new SharedWorkerWebSocket(url, port) as unknown as Shim;
      }
    }
    globalScope.WebSocket = Shim;
    try {
      return originalConnect.call(this, timeoutMs, reconnect);
    } finally {
      globalScope.WebSocket = previous;
    }
  };
}
