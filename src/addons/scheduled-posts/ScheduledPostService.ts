import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { SystemLogger } from '../../services/SystemLogger';

export interface ScheduledPost {
  id: string;
  publishAt: number;
  kind: number;
  content: string;
  relayCount: number;
  createdAt: number;
  status: string;
}

/**
 * API client for the Noornote Scheduler service.
 * Sends fully signed Nostr events to our Deno Deploy hold-and-forward service
 * which holds them until publishAt and then publishes to the user's relays.
 */
export class ScheduledPostService {
  private static instance: ScheduledPostService;
  private readonly BASE_URL = 'https://noornote-scheduler.77elements.deno.net';
  private systemLogger: SystemLogger;

  private constructor() {
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): ScheduledPostService {
    if (!ScheduledPostService.instance) {
      ScheduledPostService.instance = new ScheduledPostService();
    }
    return ScheduledPostService.instance;
  }

  /**
   * Submit a signed event for scheduled publishing.
   * @returns server-assigned id on success
   * @throws Error with server message on failure
   */
  public async schedule(
    event: NostrEvent,
    relays: string[],
    publishAt: number
  ): Promise<string> {
    const res = await fetch(`${this.BASE_URL}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, relays, publishAt }),
    });
    if (!res.ok) {
      // Scheduler error responses: { error: string } (own service — trusted shape)
      const err = (await res
        .json()
        .catch(() => ({ error: `HTTP ${res.status}` }))) as { error?: string };
      throw new Error(err.error || `Scheduler error ${res.status}`);
    }
    const data = (await res.json()) as { id?: string };
    const kindLabel =
      event.kind === 30023 ? 'Article' : event.kind === 1068 ? 'Poll' : 'Note';
    this.systemLogger.info(
      'ScheduledPostService',
      `${kindLabel} scheduled for ${new Date(publishAt * 1000).toLocaleString()}`
    );
    if (!data.id) throw new Error('Scheduler returned no id');
    return data.id;
  }

  /** List scheduled posts for a pubkey. */
  public async getScheduled(pubkey: string): Promise<ScheduledPost[]> {
    const res = await fetch(`${this.BASE_URL}/scheduled/${pubkey}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as ScheduledPost[];
  }

  /**
   * Cancel a scheduled post. Requires a signed challenge event (kind 22242) with
   * a `challenge` tag matching the scheduled-post id. The challenge must be
   * signed by the same pubkey that originally scheduled the post.
   */
  public async cancel(
    pubkey: string,
    id: string,
    challenge: NostrEvent
  ): Promise<void> {
    const res = await fetch(
      `${this.BASE_URL}/schedule/${pubkey}/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge }),
      }
    );
    if (!res.ok) {
      const err = (await res
        .json()
        .catch(() => ({ error: `HTTP ${res.status}` }))) as { error?: string };
      throw new Error(err.error || `Cancel error ${res.status}`);
    }
  }
}
