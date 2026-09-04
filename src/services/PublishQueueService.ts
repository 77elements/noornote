/**
 * PublishQueueService — offline publish retry (M6.1).
 *
 * When a signed event fails on ALL of its target relays, NostrTransport
 * emits `publish:failed-all`; this service persists the event (with its
 * original relay set) per-account and retries on reconnect, login and app
 * startup. Delivery removes the entry; repeated failure keeps it queued
 * (by-id dedup prevents re-enqueue loops from the retry path itself).
 *
 * Deliberately PerAccountLocalStorage (not a NoorDB store): the queue is a
 * small, bounded, per-account blob that must survive restarts — no query
 * needs, no large payloads. Cap: 20 entries, oldest dropped.
 *
 * Known v1 limits (documented, accepted):
 *   - kind 5 deletions are NOT queued (BroadcastDeleteService has its own
 *     resume queue) and kind 22242 AUTH events never reach this path.
 *   - The retry targets the ORIGINAL relay set — correct for everything
 *     (content, replies, reactions, DM gift-wraps to inbox relays).
 *   - Delivery of retried events keeps their original created_at (signed is
 *     immutable) — notes posted offline appear at their compose time.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { NostrTransport } from './transport/NostrTransport';
import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';
import { SystemLogger } from './SystemLogger';
import { TypedEventBus } from '../core/TypedEventBus';

interface QueuedPublish {
  event: NostrEvent;
  relays: string[];
  queuedAt: number;
}

const QUEUE_KEY = StorageKeys.PUBLISH_QUEUE;
const MAX_QUEUE_SIZE = 20;
const STARTUP_RETRY_DELAY_MS = 10_000;

export class PublishQueueService {
  private static instance: PublishQueueService | null = null;
  private transport: NostrTransport;
  private pals: PerAccountLocalStorage;
  private systemLogger: SystemLogger;
  private eventBus: TypedEventBus;
  /** Guards concurrent retry passes. */
  private retrying = false;
  private unsubscribers: (() => void)[] = [];
  private busSubscriptionIds: string[] = [];

  private constructor() {
    this.transport = NostrTransport.getInstance();
    this.pals = PerAccountLocalStorage.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.eventBus = TypedEventBus.getInstance();

    this.busSubscriptionIds.push(
      this.eventBus.on(
        'publish:failed-all',
        (data: { event: NostrEvent; relays: string[] }) => {
          this.enqueue(data.event, data.relays);
        }
      ),
      this.eventBus.on('user:login', () => {
        // Account switch: give services a moment to settle, then drain the
        // new account's queue.
        setTimeout(() => void this.retryPending(), STARTUP_RETRY_DELAY_MS);
      })
    );

    if (typeof window !== 'undefined') {
      const onOnline = () => void this.retryPending();
      window.addEventListener('online', onOnline);
      this.unsubscribers.push(() =>
        window.removeEventListener('online', onOnline)
      );
      // Startup retry: a note queued before a crash/restart goes out on boot.
      setTimeout(() => void this.retryPending(), STARTUP_RETRY_DELAY_MS);
    }
  }

  public static getInstance(): PublishQueueService {
    if (!PublishQueueService.instance) {
      PublishQueueService.instance = new PublishQueueService();
    }
    return PublishQueueService.instance;
  }

  public destroy(): void {
    this.unsubscribers.forEach(fn => fn());
    this.unsubscribers = [];
    this.busSubscriptionIds.forEach(id => this.eventBus.off(id));
    this.busSubscriptionIds = [];
    PublishQueueService.instance = null;
  }

  /** Pending entries for the current account, newest queued first. */
  public getPending(): QueuedPublish[] {
    const queue = this.pals.get<QueuedPublish[]>(QUEUE_KEY, []);
    return Array.isArray(queue) ? queue : [];
  }

  public getCount(): number {
    return this.getPending().length;
  }

  private persist(queue: QueuedPublish[]): void {
    this.pals.set(QUEUE_KEY, queue);
  }

  /**
   * Persist a failed publish for retry. By-id dedup (the retry path emits
   * `publish:failed-all` again on failure) and a hard cap with oldest-drop.
   */
  private enqueue(event: NostrEvent, relays: string[]): void {
    if (!event?.id) return;
    const queue = this.getPending().filter(e => e.event.id !== event.id);

    queue.unshift({ event, relays, queuedAt: Date.now() });
    if (queue.length > MAX_QUEUE_SIZE) {
      queue.length = MAX_QUEUE_SIZE;
    }
    this.persist(queue);

    this.systemLogger.warn(
      'PublishQueue',
      `Publish failed — event queued for retry (${queue.length} pending)`
    );
  }

  private removeFromQueue(eventId: string): void {
    this.persist(this.getPending().filter(e => e.event.id !== eventId));
  }

  /**
   * Retry every queued event for the current account against its original
   * relay set. Delivered entries are removed; failures stay queued.
   * Returns the delivery counts for diagnostics.
   */
  public async retryPending(): Promise<{
    delivered: number;
    stillPending: number;
  }> {
    if (this.retrying) {
      return { delivered: 0, stillPending: this.getCount() };
    }
    const queue = this.getPending();
    if (queue.length === 0) {
      return { delivered: 0, stillPending: 0 };
    }

    this.retrying = true;
    let delivered = 0;
    try {
      for (const entry of queue) {
        try {
          const accepted = await this.transport.publish(
            entry.relays,
            entry.event
          );
          if (accepted.size > 0) {
            this.removeFromQueue(entry.event.id!);
            delivered++;
          }
        } catch {
          // Total failure again — stays queued for the next trigger.
        }
      }

      const stillPending = this.getCount();
      if (delivered > 0) {
        this.systemLogger.success(
          'PublishQueue',
          `Delivered ${delivered} queued publish${delivered === 1 ? '' : 'es'}${
            stillPending > 0 ? ` — ${stillPending} still pending` : ''
          }`
        );
        this.eventBus.emit('publish:queue-drained', {
          delivered,
          stillPending,
        });
      }
      return { delivered, stillPending };
    } finally {
      this.retrying = false;
    }
  }
}
