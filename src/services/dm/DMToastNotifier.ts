/**
 * DMToastNotifier
 *
 * Surfaces incoming DMs via a toast with an "Open" action that jumps directly
 * into the conversation.
 *
 * Two tracks, driven by the follow gate:
 *  - Unknown senders (user does NOT follow): those conversations land in the
 *    "Unknown" tab and are easy to miss when the user only glances at the
 *    sidebar badge (which counts Known + Unknown together).
 *  - Known senders (user follows): normally only the sidebar badge diode
 *    signals arrival — the toast makes the arrival immediately visible too.
 *
 * Spec context: NIP-17 + NIP-59 allow senders to sign seals with rotating
 * one-time keys (deniability layer). Those senders never appear in the
 * user's follow list, so the DM is filed under Unknown by
 * `DMService.getConversationsFiltered`. This notifier does NOT change that
 * classification — it only makes arrivals louder.
 *
 * Burst-safe (wall-proof): at most ONE toast per track is ever on screen. A
 * burst of messages from DIFFERENT senders within one track collapses into a
 * single rolling toast that updates its text to "N new messages …" instead of
 * stacking N toasts top-to-bottom.
 *
 * Spam-attack shield: setSpamMode(true) silences the UNKNOWN track for 24 h
 * (per-account persisted, auto-expiring) so a mass wave of spam DMs can no
 * longer spam the user with toasts. Known-sender toasts keep working — they
 * are legitimate traffic. See MessagesView's "Spam mode" button.
 *
 * Anti-false-positive stack (see DMService.storeAndEmit):
 *  1. Root cause: events that ARRIVED during the live sub's pre-EOSE backlog
 *     burst carry an arrival stamp and never emit dm:new-message — the async
 *     decrypt pipeline can no longer race the EOSE gate open.
 *  2. wasUnread: the store's read-anchor verdict travels in the payload. An
 *     event that leaked through any future gate hole as "live" but is already
 *     read (relay replay / post-eviction backlog of read conversations) is
 *     ignored here — a toast must never claim unread messages that aren't.
 *  3. Follow gate is awaited (isFollowing), never isFollowingSync: the sync
 *     variant skips init(), so a live arrival before the first badge/tab call
 *     read an empty follow set and classified every sender as unknown.
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
import { _ } from '../../i18n';
import { FollowCheckService } from '../FollowCheckService';
import { UserProfileService } from '../UserProfileService';
import { PerAccountLocalStorage, StorageKeys } from '../PerAccountLocalStorage';
import { ToastService } from '../ToastService';
import { Router } from '../Router';
import { diagLog } from '../DiagnosticLogger';

/** Collapse messages closer than this into one rolling toast (per track). */
const BURST_WINDOW_MS = 8000;
/** How long the (rolling) toast stays on screen. */
const TOAST_DURATION_MS = 10000;
/** Spam-attack shield: how long an engaged spam mode stays engaged. */
const SPAM_MODE_DURATION_MS = 24 * 60 * 60 * 1000;

type TrackKey = 'known' | 'unknown';

/** Per-track burst state: count, rolling toast and its shape. */
interface BurstTrack {
  count: number;
  timer: number | null;
  toastId: string | null;
  /** True once the track's toast switched to the aggregated ("N messages") form. */
  aggregated: boolean;
}

const emptyTrack = (): BurstTrack => ({
  count: 0,
  timer: null,
  toastId: null,
  aggregated: false,
});

export class DMToastNotifier {
  private static instance: DMToastNotifier | null = null;

  private readonly eventBus = TypedEventBus.getInstance();
  private readonly followCheckService = FollowCheckService.getInstance();

  /** Conversation partner pubkeys already counted in the current unread cycle. */
  private toastedConvs = new Set<string>();

  /** One independent burst/toast state per track. */
  private tracks: Record<TrackKey, BurstTrack> = {
    known: emptyTrack(),
    unknown: emptyTrack(),
  };

  /** Subscription ids registered on the EventBus — cleaned up on destroy(). */
  private subscriptionIds: string[] = [];

  private constructor() {
    this.subscribe();
  }

  public static getInstance(): DMToastNotifier {
    if (!DMToastNotifier.instance) {
      DMToastNotifier.instance = new DMToastNotifier();
    }
    return DMToastNotifier.instance;
  }

  /** Null the singleton so the next getInstance() returns a fresh instance —
   *  called by MainLayout on account switch so the toasted-set never leaks
   *  across accounts. Mirrors the destroy contract for addon singleton
   *  services (see /skills/addons SKILL.md §4). */
  public static reset(): void {
    if (DMToastNotifier.instance) {
      DMToastNotifier.instance.destroy();
      DMToastNotifier.instance = null;
    }
  }

  /**
   * Spam-attack shield: while engaged, no unknown-sender toasts are shown at
   * all — a flood of spam DMs must not keep interrupting the user. Persists
   * per-account and auto-expires after SPAM_MODE_DURATION_MS so a forgotten
   * shield can't silently swallow legitimate unknown-sender DMs forever.
   */
  public static isSpamModeActive(): boolean {
    const until = PerAccountLocalStorage.getInstance().get<number>(
      StorageKeys.DM_SPAM_MODE_UNTIL,
      0
    );
    return until > Date.now();
  }

  /** Engage (or disengage) the spam-attack shield. Engaging immediately
   *  dismisses any unknown-DM toast currently on screen. */
  public static setSpamMode(active: boolean): void {
    PerAccountLocalStorage.getInstance().set(
      StorageKeys.DM_SPAM_MODE_UNTIL,
      active ? Date.now() + SPAM_MODE_DURATION_MS : 0
    );
    diagLog('dms', 'Unknown-DM spam mode toggled', { active });
    if (active) DMToastNotifier.instance?.resetBurstState('unknown');
  }

  private subscribe(): void {
    this.subscriptionIds.push(
      this.eventBus.on('dm:new-message', (payload: DMNewMessagePayload) => {
        void this.handleNewMessage(payload);
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

  private async handleNewMessage({
    message,
    conversationWith,
    wasUnread,
  }: DMNewMessagePayload): Promise<void> {
    // Outgoing echoes (own messages) are not interesting here.
    if (message.isMine) return;
    // Read-anchor verdict from DMStore: explicitly-read arrivals (replayed
    // backlog of read conversations) must never be claimed as unread. Filter
    // only on explicit false — undefined means "predate the flag", keep the
    // legacy assume-unread behavior.
    if (wasUnread === false) return;
    // One count contribution per conversation within the current unread cycle —
    // a burst of N messages from the SAME sender bumps the count once, not N×.
    // Reserve synchronously BEFORE the async follow check below: the await
    // yields the event loop, and without the reservation a rapid same-sender
    // burst would double-count. Entries parked here for followed senders are
    // harmless — they only gate toasting and are cleared on dm:read,
    // dm:all-read and logout.
    if (this.toastedConvs.has(conversationWith)) return;
    this.toastedConvs.add(conversationWith);
    // Awaited (NOT isFollowingSync): the sync variant reads the in-memory set
    // without bootstrapping it, so a live message arriving before the first
    // badge/tab call saw an empty set and classified every sender as unknown.
    const following =
      await this.followCheckService.isFollowing(conversationWith);
    const trackKey: TrackKey = following ? 'known' : 'unknown';

    // Unknown flood + shield engaged → silent (known track unaffected).
    if (trackKey === 'unknown' && DMToastNotifier.isSpamModeActive()) return;
    // Don't toast for the conversation the user is currently looking at.
    if (this.isConversationOpen(conversationWith)) return;

    const track = this.tracks[trackKey];
    track.count++;
    this.armBurstWindow(trackKey);
    diagLog('dms', 'DM toast counted', {
      conversationWith,
      track: trackKey,
      count: track.count,
    });

    const desiredAggregated = track.count > 1;
    // Single-sender toast opens that conversation; once aggregated (multiple
    // senders), open the messages list where the tab lists all of them.
    const target = desiredAggregated
      ? '/messages'
      : `/messages/${conversationWith}`;
    const text = desiredAggregated
      ? trackKey === 'unknown'
        ? _('%s new messages from unknown senders', String(track.count))
        : _('%s new messages from known senders', String(track.count))
      : await this.singleToastText(trackKey, conversationWith);

    // Update the visible toast in place when it's the same shape; otherwise
    // dismiss + show a fresh one (happens once per burst, at the 1→2 boundary,
    // to swap the per-conversation action for the "open messages list" one).
    let updated = false;
    if (track.toastId && track.aggregated === desiredAggregated) {
      updated = ToastService.updateMessage(track.toastId, text);
    }
    if (!updated) {
      if (track.toastId) ToastService.dismiss(track.toastId);
      track.toastId = ToastService.showWithAction(
        text,
        'info',
        {
          label: 'Open', // i18n-ok
          onClick: () => {
            Router.getInstance().navigate(target);
          },
        },
        TOAST_DURATION_MS
      );
      track.aggregated = desiredAggregated;
    }
  }

  /** Toast text for the single-message form of a track. */
  private async singleToastText(
    trackKey: TrackKey,
    conversationWith: string
  ): Promise<string> {
    if (trackKey === 'unknown') {
      return _('New message from an unknown sender');
    }
    return _(
      'New message from %s',
      await this.resolveDisplayName(conversationWith)
    );
  }

  /** Display name of the conversation partner (User Display Rule: never hex). */
  private async resolveDisplayName(pubkey: string): Promise<string> {
    try {
      const profile =
        await UserProfileService.getInstance().getUserProfile(pubkey);
      return profile?.display_name || profile?.name || `${pubkey.slice(0, 8)}…`;
    } catch {
      return `${pubkey.slice(0, 8)}…`;
    }
  }

  /** True when the given conversation is the currently open view. */
  private isConversationOpen(partnerPubkey: string): boolean {
    return Router.getInstance()
      .getCurrentPath()
      .startsWith(`/messages/${partnerPubkey}`);
  }

  /** (Re)start the burst window so a trickle of messages keeps collapsing into
   *  the current toast. When the trickle stops for BURST_WINDOW_MS, the window
   *  resets and the next message starts a fresh toast. */
  private armBurstWindow(trackKey: TrackKey): void {
    const track = this.tracks[trackKey];
    if (track.timer !== null) clearTimeout(track.timer);
    track.timer = window.setTimeout(() => {
      track.timer = null;
      this.resetBurstState(trackKey);
    }, BURST_WINDOW_MS);
  }

  /** Clear burst/toast state so the next message starts a fresh toast.
   *  Without argument, resets BOTH tracks. */
  private resetBurstState(trackKey?: TrackKey): void {
    const keys: TrackKey[] = trackKey ? [trackKey] : ['known', 'unknown'];
    keys.forEach(key => {
      const track = this.tracks[key];
      if (track.timer !== null) {
        clearTimeout(track.timer);
        track.timer = null;
      }
      track.count = 0;
      track.aggregated = false;
      if (track.toastId) {
        ToastService.dismiss(track.toastId);
        track.toastId = null;
      }
    });
  }

  public destroy(): void {
    this.subscriptionIds.forEach(id => this.eventBus.off(id));
    this.subscriptionIds = [];
    this.resetBurstState();
    this.toastedConvs.clear();
  }
}
