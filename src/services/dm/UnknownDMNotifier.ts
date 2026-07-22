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
 * Dedup strategy: toast at most once per conversation while that conversation
 * still has unread messages. The remembered pubkey is cleared on `dm:read`
 * (fired by `DMService.markAsRead`, which ConversationView calls on open —
 * so the act of opening the conversation via the toast's action button
 * automatically re-arms the toast for the next message from the same sender),
 * on `dm:all-read`, and on `user:logout`.
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

export class UnknownDMNotifier {
  private static instance: UnknownDMNotifier | null = null;

  private readonly eventBus = TypedEventBus.getInstance();
  private readonly followCheckService = FollowCheckService.getInstance();

  /** Conversation partner pubkeys for which we've already toasted a new
   *  unknown-sender message that is still unread. */
  private toastedConvs = new Set<string>();

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
        // Conversation was opened / marked read — re-arm toast for next message.
        this.toastedConvs.delete(partnerPubkey);
      }),
      this.eventBus.on('dm:all-read', () => {
        this.toastedConvs.clear();
      }),
      this.eventBus.on('user:logout', () => {
        this.toastedConvs.clear();
      }),
    );
  }

  private handleNewMessage({ message, conversationWith }: DMNewMessagePayload): void {
    // Outgoing echoes (own messages) are not interesting here.
    if (message.isMine) return;
    // Only surface senders the user does not follow. Known-sender messages
    // are already visible in the default "Known" tab.
    if (this.followCheckService.isFollowingSync(conversationWith)) return;
    // One toast per conversation while unread — burst of N messages from the
    // same sender produces one toast, not N.
    if (this.toastedConvs.has(conversationWith)) return;

    this.toastedConvs.add(conversationWith);
    diagLog('dms', 'Unknown DM toast shown', { conversationWith });

    ToastService.showWithAction(
      'New message from an unknown sender',
      'info',
      {
        label: 'Open',
        onClick: () => {
          // Landing on ConversationView for this partner triggers
          // `markAsRead`, which emits `dm:read`, which clears the dedup
          // entry — no manual cleanup needed here.
          Router.getInstance().navigate(`/messages/${conversationWith}`);
        },
      },
      10000,
    );
  }

  public destroy(): void {
    this.subscriptionIds.forEach(id => this.eventBus.off(id));
    this.subscriptionIds = [];
    this.toastedConvs.clear();
  }
}
