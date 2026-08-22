/**
 * UnknownDMNotifier
 *
 * Surfaces incoming DMs from senders the user does NOT follow via a toast,
 * because those conversations land in the "Unknown" tab and are easy to miss
 * when the user only glances at the sidebar badge (which counts Known +
 * Unknown together). The toast has an "Open" action that jumps directly into
 * the conversation.
 *
 * Spec context: NIP-17 + NIP-59 allow senders to sign seals with rotating
 * one-time keys (deniability layer). Those senders never appear in the
 * user's follow list, so the DM is filed under Unknown by
 * `DMService.getConversationsFiltered`. This notifier does NOT change that
 * classification — it only makes Unknown arrival louder.
 *
 * Burst-safe (wall-proof): at most ONE toast is ever on screen. A burst of
 * unknown-sender messages from DIFFERENT senders collapses into a single
 * rolling toast that updates its text to "N new messages from unknown senders"
 * instead of stacking N toasts top-to-bottom. This is the defence-in-depth
 * backstop: the root cause — a relay-replayed / post-eviction backlog
 * re-emitting dm:new-message — is fixed in DMService.storeAndEmit (gated on
 * the live sub's EOSE), but this notifier stays wall-proof against any future
 * upstream regression regardless.
 *
 * Dedup: one count contribution per conversation while that conversation still
 * has unread messages. The remembered pubkey is cleared on `dm:read` (fired by
 * `DMService.markAsRead`, which ConversationView calls on open — so opening the
 * conversation via the toast's action button re-arms it for the next message
 * from the same sender), on `dm:all-read`, and on `user:logout`.
 *
 * Subscribes to TypedEventBus events. No DOM of its own. Singleton, destroyed
 * and re-created on account switch by MainLayout (alongside DMBadgeManager).
 */

import { TypedEventBus } from '../../core/TypedEventBus';
import type { DMNewMessagePayload } from '../../core/events';
import { FollowCheckService } from '../FollowCheckService';
import { ToastService } from '../ToastService';
import { Router } from '../Router';
import { diagLog } from '../DiagnosticLogger';

/** Collapse unknown-sender messages closer than this into one rolling toast. */
const BURST_WINDOW_MS = 8000;
/** How long the (rolling) toast stays on screen. */
const TOAST_DURATION_MS = 10000;

export class UnknownDMNotifier {
  private static instance: UnknownDMNotifier | null = null;

  private readonly eventBus = TypedEventBus.getInstance();
  private readonly followCheckService = FollowCheckService.getInstance();

  /** Conversation partner pubkeys already counted in the current unread cycle. */
  private toastedConvs = new Set<string>();

  /** Unknown-sender messages counted in the current burst window. */
  private burstCount = 0;
  private burstWindowTimer: number | null = null;

  /** The currently-visible toast id (single or aggregated), if any. */
  private activeToastId: string | null = null;
  /** True once the current toast switched to the multi-sender ("N messages") form. */
  private aggregated = false;

  /** Subscription ids registered on the EventBus — cleaned up on destroy(). */
  private subscriptionIds: string[] = [];

  private constructor() {
    this.subscribe();
  }

  public static getInstance(): UnknownDMNotifier {
    if (!UnknownDMNotifier.instance) {
      UnknownDMNotifier.instance = new UnknownDMNotifier();
    }
    return UnknownDMNotifier.instance;
  }

  /** Null the singleton so the next getInstance() returns a fresh instance —
   *  called by MainLayout on account switch so the toasted-set never leaks
   *  across accounts. Mirrors the destroy contract for addon singleton
   *  services (see /skills/addons SKILL.md §4). */
  public static reset(): void {
    if (UnknownDMNotifier.instance) {
      UnknownDMNotifier.instance.destroy();
      UnknownDMNotifier.instance = null;
    }
  }

  private subscribe(): void {
    this.subscriptionIds.push(
      this.eventBus.on('dm:new-message', (payload: DMNewMessagePayload) => {
        this.handleNewMessage(payload);
      }),
      this.eventBus.on('dm:read', ({ partnerPubkey }) => {
        // Conversation was opened / marked read — re-arm for the next message.
        this.toastedConvs.delete(partnerPubkey);
      }),
      this.eventBus.on('dm:all-read', () => {
        this.resetBurstState();
        this.toastedConvs.clear();
      }),
      this.eventBus.on('user:logout', () => {
        this.resetBurstState();
        this.toastedConvs.clear();
      })
    );
  }

  private handleNewMessage({
    message,
    conversationWith,
  }: DMNewMessagePayload): void {
    // Outgoing echoes (own messages) are not interesting here.
    if (message.isMine) return;
    // Only surface senders the user does not follow. Known-sender messages
    // are already visible in the default "Known" tab.
    if (this.followCheckService.isFollowingSync(conversationWith)) return;
    // One count contribution per conversation within the current unread cycle —
    // a burst of N messages from the SAME sender bumps the count once, not N×.
    if (this.toastedConvs.has(conversationWith)) return;
    this.toastedConvs.add(conversationWith);

    this.burstCount++;
    this.armBurstWindow();
    diagLog('dms', 'Unknown DM toast counted', {
      conversationWith,
      burstCount: this.burstCount,
    });

    const desiredAggregated = this.burstCount > 1;
    const text = desiredAggregated
      ? `${this.burstCount} new messages from unknown senders`
      : 'New message from an unknown sender';
    // Single-sender toast opens that conversation; once aggregated (multiple
    // senders), open the messages list where the Unknown tab lists all of them.
    const target = desiredAggregated
      ? '/messages'
      : `/messages/${conversationWith}`;

    // Update the visible toast in place when it's the same shape; otherwise
    // dismiss + show a fresh one (happens once per burst, at the 1→2 boundary,
    // to swap the per-conversation action for the "open messages list" one).
    let updated = false;
    if (this.activeToastId && this.aggregated === desiredAggregated) {
      updated = ToastService.updateMessage(this.activeToastId, text);
    }
    if (!updated) {
      if (this.activeToastId) ToastService.dismiss(this.activeToastId);
      this.activeToastId = ToastService.showWithAction(
        text,
        'info',
        {
          label: 'Open',
          onClick: () => {
            Router.getInstance().navigate(target);
          },
        },
        TOAST_DURATION_MS
      );
      this.aggregated = desiredAggregated;
    }
  }

  /** (Re)start the burst window so a trickle of messages keeps collapsing into
   *  the current toast. When the trickle stops for BURST_WINDOW_MS, the window
   *  resets and the next message starts a fresh toast. */
  private armBurstWindow(): void {
    if (this.burstWindowTimer !== null) clearTimeout(this.burstWindowTimer);
    this.burstWindowTimer = window.setTimeout(() => {
      this.burstWindowTimer = null;
      this.resetBurstState();
    }, BURST_WINDOW_MS);
  }

  /** Clear burst/toast state so the next message starts a fresh toast. */
  private resetBurstState(): void {
    if (this.burstWindowTimer !== null) {
      clearTimeout(this.burstWindowTimer);
      this.burstWindowTimer = null;
    }
    this.burstCount = 0;
    this.aggregated = false;
    if (this.activeToastId) {
      ToastService.dismiss(this.activeToastId);
      this.activeToastId = null;
    }
  }

  public destroy(): void {
    this.subscriptionIds.forEach(id => this.eventBus.off(id));
    this.subscriptionIds = [];
    this.resetBurstState();
    this.toastedConvs.clear();
  }
}
