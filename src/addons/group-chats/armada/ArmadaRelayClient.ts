/**
 * ArmadaRelayClient — Raw-WebSocket client for Concord V2 community relays.
 *
 * Concord relays serve kind-1059 gift wraps filtered by stream-key authors.
 * This client opens a direct WebSocket (bypassing NDK entirely — NDK's
 * subscription layer returned 0 for `authors`-filtered kind-1059 queries
 * while a raw WebSocket returned 10/10 on the same relay).
 *
 * NIP-42: if the relay sends an AUTH challenge, the client signs with each
 * registered stream key's private key (needed on ditto-relay; jskitty.com
 * does not require auth).
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { finalizeEvent } from 'nostr-tools/pure';
import { AuthService } from '../../../services/AuthService';
import { diagLog } from '../../../services/DiagnosticLogger';
import type { GroupKey } from './concordGroupKey';

const KIND_AUTH = 22242;
const FETCH_TIMEOUT_MS = 15000;

export class ArmadaRelayClient {
  private streamKeys: GroupKey[] = [];
  private authService: AuthService;
  private destroyed = false;

  constructor() {
    this.authService = AuthService.getInstance();
  }

  /** Register the stream keys for NIP-42 auth challenges. */
  public setStreamKeys(keys: GroupKey[]): void {
    this.streamKeys = keys;
  }

  /**
   * Fetch gift wraps by stream-key authors from community relays. Tries
   * each relay in order until one delivers events.
   */
  public async fetchWraps(
    relayUrls: string[],
    authors: string[],
    since: number
  ): Promise<NostrEvent[]> {
    if (authors.length === 0 || this.destroyed) return [];

    for (const relayUrl of relayUrls) {
      if (this.destroyed) break;
      try {
        const events = await this.fetchFromRelay(relayUrl, authors, since);
        if (events.length > 0) return events;
      } catch (error) {
        diagLog('addons', 'armada: relay fetch failed', {
          relay: relayUrl,
          error: String(error),
        });
      }
    }
    return [];
  }

  /**
   * Raw-WebSocket fetch from a single relay. Handles NIP-42 AUTH challenges
   * by signing with registered stream keys + user key.
   */
  private fetchFromRelay(
    relayUrl: string,
    authors: string[],
    since: number
  ): Promise<NostrEvent[]> {
    return new Promise<NostrEvent[]>((resolve, reject) => {
      const buffer = new Map<string, NostrEvent>();
      let settled = false;
      let ws: WebSocket | null = null;
      let reqSent = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws?.close();
        } catch {
          /* best-effort */
        }
        resolve(Array.from(buffer.values()));
      };

      const timer = setTimeout(() => {
        if (!settled) {
          if (reqSent && buffer.size > 0) {
            // Got some events but no EOSE — return what we have
            finish();
          } else {
            finish();
          }
        }
      }, FETCH_TIMEOUT_MS);

      const sendReq = () => {
        if (!ws || ws.readyState !== WebSocket.OPEN || reqSent) return;
        reqSent = true;
        ws.send(
          JSON.stringify([
            'REQ',
            'armada-poll',
            {
              kinds: [1059],
              authors,
              since,
              limit: 100,
            },
          ])
        );
      };

      try {
        ws = new WebSocket(relayUrl);
      } catch {
        reject(new Error(`WebSocket creation failed: ${relayUrl}`));
        return;
      }

      ws.onopen = () => sendReq();

      ws.onmessage = async e => {
        try {
          // Nostr WS frame: [verb, ...args] (relay-controlled)
          const data = JSON.parse(String(e.data)) as unknown[];
          if (data[0] === 'AUTH') {
            // NIP-42 challenge — sign with stream keys + user key, then resend REQ
            for (const gk of this.streamKeys) {
              try {
                const signed = finalizeEvent(
                  {
                    kind: KIND_AUTH,
                    created_at: Math.floor(Date.now() / 1000),
                    content: '',
                    tags: [
                      ['relay', relayUrl],
                      ['challenge', String(data[1] ?? '')],
                    ],
                  },
                  gk.sk
                ) as NostrEvent;
                ws?.send(JSON.stringify(['AUTH', signed]));
              } catch {
                /* best-effort */
              }
            }
            const pubkey = this.authService.getCurrentUser()?.pubkey;
            if (pubkey) {
              try {
                const userAuth = (await this.authService.signEvent({
                  kind: KIND_AUTH,
                  created_at: Math.floor(Date.now() / 1000),
                  content: '',
                  tags: [
                    ['relay', relayUrl],
                    ['challenge', String(data[1] ?? '')],
                  ],
                })) as NostrEvent;
                ws?.send(JSON.stringify(['AUTH', userAuth]));
              } catch {
                /* best-effort */
              }
            }
            // Allow re-sending REQ after auth
            reqSent = false;
            sendReq();
          } else if (
            data[0] === 'EVENT' &&
            typeof data[2] === 'object' &&
            data[2] !== null &&
            'id' in data[2]
          ) {
            const ev = data[2] as NostrEvent & { id: string };
            buffer.set(ev.id, ev);
          } else if (data[0] === 'EOSE') {
            finish();
          } else if (data[0] === 'CLOSED') {
            finish();
          }
        } catch {
          // Malformed frame — ignore
        }
      };

      ws.onerror = () => {
        /* timeout handles failure */
      };
      ws.onclose = () => finish();
    });
  }

  public destroy(): void {
    this.destroyed = true;
    this.streamKeys = [];
  }
}
