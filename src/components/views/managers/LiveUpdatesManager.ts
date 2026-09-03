/**
 * LiveUpdatesManager
 * Handles live updates and TypedEventBus subscriptions for SingleNoteView:
 * - Live reply subscription
 * - Live reactions polling
 * - Zap events
 * - Mute events
 * - Delete events
 * - Reply confirmation
 */

import { ModuleLoader } from '../../../core/ModuleLoader';
import type { SingleNoteModuleApi } from '../../../modules/single-note/contracts';
import type { ReactionsModuleApi } from '../../../modules/reactions/contracts';
import { SystemLogger } from '../../../services/SystemLogger';
import { TypedEventBus } from '../../../core/TypedEventBus';
import { Router } from '../../../services/Router';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { InteractionStats } from '../../../services/InteractionStatsService';

export interface LiveUpdatesConfig {
  noteId: string;
  onLiveReply?: (reply: NostrEvent) => void;
  onStatsUpdate?: (stats: InteractionStats) => void;
  onZapAdded?: (noteId: string) => void;
  onQuotedRepost?: (event: NostrEvent) => void;
  onMuteUpdated?: () => void;
  onNoteDeleted?: () => void;
}

export class LiveUpdatesManager {
  private config: LiveUpdatesConfig;
  private _singleNoteApi?: SingleNoteModuleApi | null;
  private get singleNoteApi(): SingleNoteModuleApi | null {
    return (this._singleNoteApi ??=
      ModuleLoader.getInstance().getApi<SingleNoteModuleApi>('single-note'));
  }
  private _reactionsApi?: ReactionsModuleApi | null;
  private get reactionsApi(): ReactionsModuleApi | null {
    return (this._reactionsApi ??=
      ModuleLoader.getInstance().getApi<ReactionsModuleApi>('reactions'));
  }
  private systemLogger: SystemLogger;
  private eventBus: TypedEventBus;
  private router: Router;

  private zapAddedUnsubscribe?: string;
  private muteUpdatedUnsubscribe?: string;
  private deleteUnsubscribe?: string;
  private replyCreatedUnsubscribe?: string;

  constructor(config: LiveUpdatesConfig) {
    this.config = config;
    this.systemLogger = SystemLogger.getInstance();
    this.eventBus = TypedEventBus.getInstance();
    this.router = Router.getInstance();
  }

  /**
   * Start all live update subscriptions
   */
  public startLiveUpdates(): void {
    this.systemLogger.info(
      'LiveUpdatesManager',
      `🔴 Starting live updates for note ${this.config.noteId.slice(0, 8)}`
    );

    // Start live reply subscription (real-time)
    this.singleNoteApi?.startLiveReplies(this.config.noteId, newReply => {
      if (this.config.onLiveReply) {
        this.config.onLiveReply(newReply);
      }
    });

    // Start live reactions polling (30s interval)
    this.reactionsApi?.startLiveReactions(
      this.config.noteId,
      stats => {
        if (this.config.onStatsUpdate) {
          this.config.onStatsUpdate(stats);
        }
      },
      { interval: 30000 }
    ); // 30 seconds

    // Real-time interaction subscription (kinds 7/9735/6/16) — instant lists
    // and counters; the 30s poll above stays as a catch-up fallback.
    this.reactionsApi?.startLiveStats(
      this.config.noteId,
      stats => {
        if (this.config.onStatsUpdate) {
          this.config.onStatsUpdate(stats);
        }
      },
      event => {
        if (this.config.onQuotedRepost) {
          this.config.onQuotedRepost(event);
        }
      }
    );

    // Setup TypedEventBus listeners
    this.setupZapListener();
    this.setupMuteListener();
    this.setupDeleteListener();
    this.setupReplyListener();
  }

  /**
   * Setup listener for zap events to refresh ZapsList
   */
  private setupZapListener(): void {
    this.zapAddedUnsubscribe = this.eventBus.on(
      'zap:added',
      (data: { noteId: string }) => {
        if (data.noteId === this.config.noteId) {
          if (this.config.onZapAdded) {
            this.config.onZapAdded(data.noteId);
          }
        }
      }
    );
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
    this.deleteUnsubscribe = this.eventBus.on(
      'note:deleted',
      (data: { eventId: string }) => {
        if (data.eventId === this.config.noteId) {
          if (this.config.onNoteDeleted) {
            this.config.onNoteDeleted();
          } else {
            // Default: Navigate back to timeline
            this.router.navigate('/');
          }
        }
      }
    );
  }

  /**
   * Setup listener for reply creation (optimistic UI update)
   */
  private setupReplyListener(): void {
    this.replyCreatedUnsubscribe = this.eventBus.on(
      'reply:created',
      (replyEvent: NostrEvent) => {
        // Check if this reply is for the current note OR any reply in the thread
        const eTags = replyEvent.tags.filter(tag => tag[0] === 'e');

        // Check root note (first e-tag with "root" marker or first e-tag)
        const rootTag = eTags.find(tag => tag[3] === 'root') || eTags[0];
        const isInCurrentThread = rootTag && rootTag[1] === this.config.noteId;

        const replyId = replyEvent.id;
        if (isInCurrentThread && replyId) {
          this.systemLogger.info(
            'LiveUpdatesManager',
            `🔔 Reply created event received for thread: ${replyId.slice(0, 8)}`
          );
          if (this.config.onLiveReply) {
            this.config.onLiveReply(replyEvent);
          }
        }
      }
    );
  }

  /**
   * Subscribe to write relays to confirm reply event arrival
   * Once confirmed on at least one relay, callback is called
   */
  public async subscribeForReplyConfirmation(
    replyId: string,
    onConfirmed: () => void
  ): Promise<void> {
    this.systemLogger.info(
      'LiveUpdatesManager',
      `🔍 Subscribing for reply confirmation: ${replyId.slice(0, 8)}`
    );

    await this.singleNoteApi?.waitForReplyOnRelays(replyId, onConfirmed);
  }

  /**
   * Cleanup all subscriptions
   */
  public destroy(): void {
    // Unsubscribe from TypedEventBus
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
    this.singleNoteApi?.stopLiveReplies(this.config.noteId);
    this.reactionsApi?.stopLiveReactions(this.config.noteId);
    this.reactionsApi?.stopLiveStats(this.config.noteId);

    this.systemLogger.info(
      'LiveUpdatesManager',
      'Destroyed live updates manager'
    );
  }
}
