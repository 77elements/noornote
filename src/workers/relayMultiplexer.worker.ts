/**
 * Relay multiplexer SharedWorker.
 *
 * ONE WebSocket per relay URL for ALL browser tabs of this origin: each tab
 * opens its relay sockets through this worker instead of holding its own.
 * This is what keeps heavy multi-tab use under the browser's global
 * WebSocket budget (~255 in Chromium, ~200 in Firefox — shared across tabs).
 *
 * Pure string plumbing: the worker never parses Nostr protocol messages,
 * it only forwards what a tab sends to the socket and broadcasts what the
 * socket receives back to every tab. NIP-42 AUTH, subscriptions, closing
 * tags — all remain main-thread NDK concerns.
 *
 * Epochs: every socket generation gets a per-url counter value. A tab shim
 * accepts only traffic stamped with its own epoch, so shims orphaned by a
 * reconnect go silent and can be garbage-collected.
 *
 * Protocol (all messages `{ url, ... }`):
 *   tab → worker    : { type:'attach', token } | { type:'send', data }
 *                   | { type:'detach' }
 *   worker → tab    : { type:'attached', token, epoch, state }
 *                   | { type:'open'|'message'|'close'|'error', epoch, data? }
 *   (broadcasts are epoch-stamped and fan out to every port)
 */

interface SocketEntry {
  ws: WebSocket;
  refs: number;
  epoch: number;
}

interface AttachMsg {
  type: 'attach';
  url: string;
  token: number;
}
interface SendMsg {
  type: 'send';
  url: string;
  data: string;
}
interface DetachMsg {
  type: 'detach';
  url: string;
}
type InMsg = AttachMsg | SendMsg | DetachMsg;

interface MultiplexerMsg {
  type: 'attached' | 'open' | 'message' | 'close' | 'error';
  url: string;
  token?: number;
  epoch?: number;
  state?: 'connecting' | 'open';
  data?: string;
}

type Ctx = {
  onconnect: ((e: MessageEvent) => void) | null;
};
const ctx = self as unknown as Ctx;

const sockets = new Map<string, SocketEntry>();
const epochs = new Map<string, number>();
const ports: MessagePort[] = [];

function broadcast(msg: MultiplexerMsg): void {
  for (let i = ports.length - 1; i >= 0; i--) {
    const port = ports[i];
    if (!port) continue;
    try {
      port.postMessage(msg);
    } catch {
      // Port died (tab closed) — drop it so the list stays bounded.
      ports.splice(i, 1);
    }
  }
}

ctx.onconnect = (e: MessageEvent): void => {
  const port: MessagePort = e.ports[0] as MessagePort;
  ports.push(port);

  port.onmessage = (ev: MessageEvent<InMsg>): void => {
    const msg = ev.data;
    if (msg.type === 'attach') {
      let entry = sockets.get(msg.url);
      // A dying generation is never reused — attach creates a fresh one.
      if (entry && entry.ws.readyState > 1) {
        sockets.delete(msg.url);
        entry = undefined;
      }
      if (!entry) {
        const epoch = (epochs.get(msg.url) ?? 0) + 1;
        epochs.set(msg.url, epoch);
        const ws = new WebSocket(msg.url);
        entry = { ws, refs: 0, epoch };
        sockets.set(msg.url, entry);
        ws.onopen = () => broadcast({ type: 'open', url: msg.url, epoch });
        ws.onmessage = (m: MessageEvent) =>
          broadcast({
            type: 'message',
            url: msg.url,
            epoch,
            data: m.data as string,
          });
        ws.onclose = () => {
          broadcast({ type: 'close', url: msg.url, epoch });
          if (sockets.get(msg.url)?.ws === ws) sockets.delete(msg.url);
        };
        ws.onerror = () => broadcast({ type: 'error', url: msg.url, epoch });
        port.postMessage({
          type: 'attached',
          url: msg.url,
          token: msg.token,
          epoch,
          state: 'connecting',
        });
      } else {
        port.postMessage({
          type: 'attached',
          url: msg.url,
          token: msg.token,
          epoch: entry.epoch,
          state: entry.ws.readyState === 1 ? 'open' : 'connecting',
        });
      }
      entry.refs++;
    } else if (msg.type === 'send') {
      sockets.get(msg.url)?.ws.send(msg.data);
    } else if (msg.type === 'detach') {
      const entry = sockets.get(msg.url);
      if (!entry) return;
      entry.refs--;
      if (entry.refs <= 0) {
        entry.ws.close();
        sockets.delete(msg.url);
      }
    }
  };

  port.start();
};

export {};
