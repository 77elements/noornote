/**
 * LiveUpdatesManager
 * Handles live updates and EventBus subscriptions for SingleNoteView:
 * - Live reply subscription
 * - Live reactions polling
 * - Zap events
 * - Mute events
 * - Delete events
 * - Reply confirmation
 */

import { ThreadOrchestrator } from '../../../services/orchestration/ThreadOrchestrator';
import { ReactionsOrchestrator } from '../../../services/orchestration/ReactionsOrchestrator';
import { RelayConfig } from '../../../services/RelayConfig';
import { SystemLogger } from '../../system/SystemLogger';
import { EventBus } from '../../../services/EventBus';
import { NostrTransport } from '../../../services/transport/NostrTransport';
import { Router } from '../../../services/Router';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { InteractionStats } from '../../../services/InteractionStatsService';

export interface LiveUpdatesConfig {
  noteId: string;
  onLiveReply?: (reply: NostrEvent) => void;
  onStatsUpdate?: (stats: InteractionStats) => void;
  onZapAdded?: (noteId: string) => void;
  onMuteUpdated?: () => void;
  onNoteDeleted?: () => void;
}

export class LiveUpdatesManager {
  private config: LiveUpdatesConfig;
  private threadOrchestrator: ThreadOrchestrator;
  private reactionsOrchestrator: ReactionsOrchestrator;
  private relayConfig: RelayConfig;
  private systemLogger: SystemLogger;
  private eventBus: EventBus;
  private transport: NostrTransport;
  private router: Router;

  private zapAddedUnsubscribe?: string;
  private muteUpdatedUnsubscribe?: string;
  private deleteUnsubscribe?: string;
  private replyCreatedUnsubscribe?: string;

  constructor(config: LiveUpdatesConfig) {
    this.config = config;
    this.threadOrchestrator = ThreadOrchestrator.getInstance();
    this.reactionsOrchestrator = ReactionsOrchestrator.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.eventBus = EventBus.getInstance();
    this.transport = NostrTransport.getInstance();
    this.router = Router.getInstance();
  }

  /**
   * Start all live update subscriptions
   */
  public startLiveUpdates(): void {
    this.systemLogger.info('LiveUpdatesManager', `🔴 Starting live updates for note ${this.config.noteId.slice(0, 8)}`);

    // Start live reply subscription (real-time)
    this.threadOrchestrator.startLiveReplies(this.config.noteId, (newReply) => {
      if (this.config.onLiveReply) {
        this.config.onLiveReply(newReply);
      }
    });

    // Start live reactions polling (30s interval)
    this.reactionsOrchestrator.startLiveReactions(this.config.noteId, (stats) => {
      if (this.config.onStatsUpdate) {
        this.config.onStatsUpdate(stats);
      }
    }, { interval: 30000 }); // 30 seconds

    // Setup EventBus listeners
    this.setupZapListener();
    this.setupMuteListener();
    this.setupDeleteListener();
    this.setupReplyListener();
  }

  /**
   * Setup listener for zap events to refresh ZapsList
   */
  private setupZapListener(): void {
    this.zapAddedUnsubscribe = this.eventBus.on('zap:added', (data: { noteId: string }) => {
      if (data.noteId === this.config.noteId) {
        if (this.config.onZapAdded) {
          this.config.onZapAdded(data.noteId);
        }
      }
    });
  }

  /**
   * Setup listener for mute events to re-render note
   */
  private setupMuteListener(): void {
    this.muteUpdatedUnsubscribe = this.eventBus.on('mute:updated', () => {
      if (this.config.onMuteUpdated) {
        this.config.onMuteUpdated();
      }
    });
  }

  /**
   * Setup listener for note deletions
   */
  private setupDeleteListener(): void {
    this.deleteUnsubscribe = this.eventBus.on('note:deleted', (data: { eventId: string }) => {
      if (data.eventId === this.config.noteId) {
        if (this.config.onNoteDeleted) {
          this.config.onNoteDeleted();
        } else {
          // Default: Navigate back to timeline
          this.router.navigate('/');
        }
      }
    });
  }

  /**
   * Setup listener for reply creation (optimistic UI update)
   */
  private setupReplyListener(): void {
    this.replyCreatedUnsubscribe = this.eventBus.on('reply:created', (replyEvent: NostrEvent) => {
      // Check if this reply is for the current note OR any reply in the thread
      const eTags = replyEvent.tags.filter(tag => tag[0] === 'e');

      // Check root note (first e-tag with "root" marker or first e-tag)
      const rootTag = eTags.find(tag => tag[3] === 'root') || eTags[0];
      const isInCurrentThread = rootTag && rootTag[1] === this.config.noteId;

      if (isInCurrentThread) {
        this.systemLogger.info('LiveUpdatesManager', `🔔 Reply created event received for thread: ${replyEvent.id.slice(0, 8)}`);
        if (this.config.onLiveReply) {
          this.config.onLiveReply(replyEvent);
        }
      }
    });
  }

  /**
   * Subscribe to write relays to confirm reply event arrival
   * Once confirmed on at least one relay, callback is called
   */
  public async subscribeForReplyConfirmation(replyId: string, onConfirmed: () => void): Promise<void> {
    const writeRelays = this.relayConfig.getWriteRelays();

    if (writeRelays.length === 0) {
      // No write relays configured, assume confirmed
      onConfirmed();
      return;
    }

    this.systemLogger.info('LiveUpdatesManager', `🔍 Subscribing for reply confirmation: ${replyId.slice(0, 8)}`);

    // Subscribe to write relays with a filter for this specific event
    const sub = await this.transport.subscribe(
      writeRelays,
      [{ ids: [replyId] }],
      {
        onEvent: (event) => {
          if (event.id === replyId) {
            this.systemLogger.info('LiveUpdatesManager', `✓ Reply confirmed on relay: ${replyId.slice(0, 8)}`);
            onConfirmed();
            sub.close(); // Unsubscribe after confirmation
          }
        }
      }
    );

    // Set timeout to confirm anyway after 5 seconds (fallback)
    setTimeout(() => {
      this.systemLogger.warn('LiveUpdatesManager', `⏱️ Reply confirmation timeout, assuming success: ${replyId.slice(0, 8)}`);
      onConfirmed();
      sub.close();
    }, 5000);
  }

  /**
   * Cleanup all subscriptions
   */
  public destroy(): void {
    // Unsubscribe from EventBus
    if (this.zapAddedUnsubscribe) {
      this.eventBus.off(this.zapAddedUnsubscribe);
    }
    if (this.muteUpdatedUnsubscribe) {
      this.eventBus.off(this.muteUpdatedUnsubscribe);
    }
    if (this.deleteUnsubscribe) {
      this.eventBus.off(this.deleteUnsubscribe);
    }
    if (this.replyCreatedUnsubscribe) {
      this.eventBus.off(this.replyCreatedUnsubscribe);
    }

    // Stop orchestrators
    this.threadOrchestrator.stopLiveReplies(this.config.noteId);
    this.reactionsOrchestrator.stopLiveReactions(this.config.noteId);

    this.systemLogger.info('LiveUpdatesManager', 'Destroyed live updates manager');
  }
}
