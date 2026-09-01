/**
 * SnvZapsListController — the ONE renderer for the SNV zaps/likes lists.
 *
 * Replaces the previous dual-path pipeline (sync badge + debounced chain +
 * fetch). Guarantees (enforced by SnvZapsListController.test.ts):
 *
 * 1. TRUE optimistic UI: zap lifecycle events rebuild the list SYNCHRONOUSLY
 *    in the same tick — no debounce, no chain hold, no data fetch.
 * 2. Optimistic rows flow through the same ZapsList markup path as receipt
 *    rows — identical display, no invented pending styling.
 * 3. Receipt data replaces optimistic rows (reconcile by bolt11) — no dupes.
 * 4. Relay fetches never block rendering; one re-render when fresh data
 *    lands (identity check — no loops).
 */

import type {
  DetailedStats,
  InteractionStats,
  ReactionsModuleApi,
} from '../../../modules/reactions/contracts';
import type { ZapsModuleApi } from '../../../modules/zaps/contracts';
import { TypedEventBus } from '../../../core/TypedEventBus';
import { ZapsList } from '../../ui/ZapsList';
import { LikesList } from '../../ui/LikesList';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

const EMPTY_STATS: DetailedStats = {
  replyEvents: [],
  repostEvents: [],
  quotedEvents: [],
  reactionEvents: [],
  zapEvents: [],
  lastUpdated: 0,
};

/** Upper bound for serving cached stats without a background refresh. */
const STATS_CACHE_REFRESH_MS = 30_000;

interface AttachedNote {
  authorPubkey: string;
  noteElement: HTMLElement;
  /** Addressable notes: hex event id for dual-tag (#a + #e) stats searches. */
  detailedStatsEventId?: string;
  /** Full original event → LikesList builds NIP-25-compliant addressable tags. */
  likesContext?: NostrEvent;
  /** Real-time interaction stats (kinds 7/9735/6/16) with a view callback. */
  liveStats?: { onStats: (stats: InteractionStats) => void };
  liveStatsStarted?: boolean;
}

export class SnvZapsListController {
  private entries = new Map<string, AttachedNote>();
  private chain: Promise<void> = Promise.resolve();
  private lifecycleSubIds: string[] = [];
  private likesSignature = new Map<string, string>();

  constructor(
    private getReactionsSync: () => ReactionsModuleApi | null,
    private getReactionsAsync: () => Promise<ReactionsModuleApi | null>,
    private getZaps: () => ZapsModuleApi | null
  ) {
    const bus = TypedEventBus.getInstance();
    this.lifecycleSubIds = [
      bus.on('zap:pending', payload => this.onLifecycle(payload)),
      bus.on('zap:succeeded', payload => this.onLifecycle(payload)),
      bus.on('zap:failed', payload => this.onLifecycle(payload)),
    ];
  }

  /**
   * Register a note element (root SNV note, a reply note, or an article).
   * Options (all optional): detailedStatsEventId for addressable dual-tag
   * searches, likesContext for NIP-25-compliant likes rows, liveStats for the
   * real-time interaction subscription with a view callback.
   */
  public attach(
    noteId: string,
    authorPubkey: string,
    noteElement: HTMLElement,
    options?: {
      detailedStatsEventId?: string;
      likesContext?: NostrEvent;
      liveStats?: { onStats: (stats: InteractionStats) => void };
    }
  ): void {
    this.entries.set(noteId, {
      authorPubkey,
      noteElement,
      ...(options?.detailedStatsEventId !== undefined && {
        detailedStatsEventId: options.detailedStatsEventId,
      }),
      ...(options?.likesContext !== undefined && {
        likesContext: options.likesContext,
      }),
      ...(options?.liveStats !== undefined && { liveStats: options.liveStats }),
      liveStatsStarted: false,
    });
    void this.renderViaChain(noteId);
  }

  public detach(noteId: string): void {
    const entry = this.entries.get(noteId);
    if (entry?.liveStatsStarted) {
      this.getReactionsSync()?.stopLiveStats(noteId);
    }
    this.entries.delete(noteId);
    this.likesSignature.delete(noteId);
  }

  /** Re-render now + background refresh (live-stats / zap:added paths). */
  public refresh(noteId: string): void {
    if (!this.entries.has(noteId)) return;
    this.renderNow(noteId);
    void this.renderViaChain(noteId);
  }

  public destroy(): void {
    const bus = TypedEventBus.getInstance();
    this.lifecycleSubIds.forEach(id => bus.off(id));
    this.lifecycleSubIds = [];
    this.entries.forEach((entry, noteId) => {
      if (entry.liveStatsStarted) {
        this.getReactionsSync()?.stopLiveStats(noteId);
      }
    });
    this.entries.clear();
    this.likesSignature.clear();
  }

  private onLifecycle(payload: {
    noteId: string;
    invoice: string;
    amount: number;
  }): void {
    if (!this.entries.has(payload.noteId)) return;
    // TRUE optimistic UI: synchronous full rebuild in the same tick — no
    // debounce, no chain hold, no data fetch. The chain later converges data.
    this.renderNow(payload.noteId);
    void this.renderViaChain(payload.noteId);
  }

  /**
   * Full rebuild from (cache ∪ pendingStates) — synchronous, atomic DOM swap.
   * The ONLY place that renders the zaps/likes lists, so every state is
   * derived from the same data and nothing can get "stuck".
   */
  private renderNow(noteId: string): void {
    const entry = this.entries.get(noteId);
    if (!entry) return;
    const reactions = this.getReactionsSync();
    const zaps = this.getZaps();
    const stats = reactions?.peekDetailedStats(noteId) ?? EMPTY_STATS;
    zaps?.reconcileZapStates(noteId, stats.zapEvents);
    const pendingStates = zaps?.getZapPendingStates(noteId) ?? [];

    const { noteElement } = entry;
    const islContainer = noteElement.querySelector('.isl');
    if (!islContainer?.parentNode) return;

    noteElement.querySelector('.zaps-list')?.remove();
    if (stats.zapEvents.length > 0 || pendingStates.length > 0) {
      const zapsList = new ZapsList(stats.zapEvents, pendingStates);
      islContainer.parentNode.insertBefore(zapsList.getElement(), islContainer);
    }

    // Likes: re-render only when the reaction set actually changed — lifecycle
    // events fire on zap activity and must not churn the likes list.
    const signature = stats.reactionEvents
      .map((e: NostrEvent) => e.id ?? '')
      .join(',');
    if (this.likesSignature.get(noteId) === signature) return;
    this.likesSignature.set(noteId, signature);
    noteElement.querySelector('.likes-list')?.remove();
    if (stats.reactionEvents.length === 0) return;

    void (async () => {
      const likesList = new LikesList(
        stats.reactionEvents,
        noteId,
        entry.authorPubkey,
        entry.likesContext
      );
      await likesList.init();
      if (!noteElement.isConnected) return;
      const container = noteElement.querySelector('.isl');
      if (!container?.parentNode) return;
      noteElement.querySelector('.likes-list')?.remove();
      container.parentNode.insertBefore(likesList.getElement(), container);
    })();
  }

  /**
   * Chained run: instant render from cache + a background fetch when the
   * cache is stale; one re-render when fresh data lands (identity check —
   * getDetailedStats returns the same object on cache hit → no loop).
   */
  private renderViaChain(noteId: string): Promise<void> {
    const run = async (): Promise<void> => {
      const reactions = await this.getReactionsAsync();
      const entry = this.entries.get(noteId);
      if (!reactions || !entry) return;

      // Real-time interaction stats (articles and any view that opts in):
      // started once per attached note, stopped on detach/destroy.
      if (entry.liveStats && !entry.liveStatsStarted) {
        entry.liveStatsStarted = true;
        reactions.startLiveStats(noteId, stats => {
          entry.liveStats?.onStats(stats);
          this.renderNow(noteId);
        });
      }

      const cached = reactions.peekDetailedStats(noteId) ?? null;
      this.renderNow(noteId);
      if (cached && Date.now() - cached.lastUpdated < STATS_CACHE_REFRESH_MS) {
        return;
      }
      void reactions
        .getDetailedStats(noteId, entry.detailedStatsEventId)
        .then(fresh => {
          if (!fresh || fresh === cached) return;
          this.renderNow(noteId);
        })
        .catch(() => undefined);
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }
}
