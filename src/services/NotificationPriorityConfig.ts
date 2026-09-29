/**
 * Canonical notification-priority defaults + reader.
 *
 * Single source of truth shared by the Settings UI (NotificationPrioritySection)
 * and the diode priority computation (NotificationsOrchestrator). Previously the
 * orchestrator carried its own inline copy of the defaults that had drifted
 * (missing image-tag / zap-reply), and the section's exported getter was
 * unusable from services — the components → services import direction is
 * forbidden, so the getter was dead code.
 */

import {
  PerAccountLocalStorage,
  StorageKeys,
  type NotificationPriority,
  type NotificationPriorityMap,
} from './PerAccountLocalStorage';

export const DEFAULT_PRIORITIES: NotificationPriorityMap = {
  reply: 1,
  quote: 1,
  zap: 1,
  'image-tag': 1,
  'zap-reply': 2,
  mention: 2,
  repost: 2,
  reaction: 2,
  article: 2,
  mutual_new: 2,
  mutual_unfollow: 2,
  follower_new: 2,
  'thread-reply': 3,
  hashtag: 3,
  dhikr_round: 3,
  dhikr_commit: 3,
  dhikr_complete: 3,
  'group-chats': 2,
  nostrord: 2,
  armada: 2,
};

export function getNotificationPriorities(): NotificationPriorityMap {
  const storage = PerAccountLocalStorage.getInstance();
  const saved = storage.get<NotificationPriorityMap>(
    StorageKeys.NOTIFICATION_PRIORITIES,
    {}
  );
  return { ...DEFAULT_PRIORITIES, ...saved };
}

export type { NotificationPriority, NotificationPriorityMap };
