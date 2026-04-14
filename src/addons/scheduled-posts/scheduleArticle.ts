/**
 * Schedule a Kind 30023 article for later publishing.
 *
 * Builds the unsigned event, signs it locally via AuthService, and hands it
 * off to the Noornote Scheduler. `created_at` is set to the scheduled moment
 * so relays accept the timestamp when the scheduler publishes at publishAt.
 *
 * Tag-building mirrors ArticleService.createArticleEvent() for behavioural
 * parity. Kind 30024 drafts are intentionally not supported.
 */

import { AuthService } from '../../services/AuthService';
import { SystemLogger } from '../../components/system/SystemLogger';
import { ErrorService } from '../../services/ErrorService';
import { ToastService } from '../../services/ToastService';
import { encodeNaddr } from '../../services/NostrToolsAdapter';
import { EventBus } from '../../services/EventBus';
import { diagLog } from '../../services/DiagnosticLogger';
import { ScheduledPostService } from './ScheduledPostService';

export interface ScheduleArticleOptions {
  title: string;
  content: string;
  identifier: string;
  summary?: string;
  image?: string;
  topics?: string[];
  publishedAt?: number;
  relays: string[];
  /** Unix timestamp when the scheduler should publish the event. */
  scheduledAt: number;
}

const MIN_DELAY_S = 60;
const MAX_DELAY_S = 30 * 24 * 60 * 60;

export async function scheduleArticle(options: ScheduleArticleOptions): Promise<string | null> {
  const logger = SystemLogger.getInstance();
  const auth = AuthService.getInstance();
  const {
    title, content, identifier, summary, image, topics, publishedAt, relays, scheduledAt,
  } = options;

  const currentUser = auth.getCurrentUser();
  if (!currentUser) {
    logger.error('scheduleArticle', 'User not authenticated');
    return null;
  }

  if (!title || title.trim().length === 0) {
    ToastService.show('Title is required', 'error');
    return null;
  }
  if (!content || content.trim().length === 0) {
    ToastService.show('Content is required', 'error');
    return null;
  }
  if (!identifier || identifier.trim().length === 0) {
    ToastService.show('Identifier/slug is required', 'error');
    return null;
  }
  if (!relays || relays.length === 0) {
    ToastService.show('Please select at least one relay', 'error');
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (scheduledAt <= now + MIN_DELAY_S) {
    ToastService.show('Scheduled time must be at least 1 minute in the future', 'error');
    return null;
  }
  if (scheduledAt > now + MAX_DELAY_S) {
    ToastService.show('Scheduled time cannot be more than 30 days in the future', 'error');
    return null;
  }

  try {
    const kind = 30023;

    const tags: string[][] = [
      ['d', identifier.trim()],
      ['title', title.trim()],
    ];

    if (summary && summary.trim().length > 0) tags.push(['summary', summary.trim()]);
    if (image && image.trim().length > 0) tags.push(['image', image.trim()]);
    tags.push(['published_at', String(publishedAt || scheduledAt)]);

    if (topics && topics.length > 0) {
      topics.forEach(topic => {
        const trimmed = topic.trim();
        if (trimmed.length > 0) tags.push(['t', trimmed.toLowerCase()]);
      });
    }

    const unsignedEvent = {
      kind,
      created_at: scheduledAt,
      tags,
      content: content.trim(),
      pubkey: currentUser.pubkey,
    };

    const signedEvent = await auth.signEvent(unsignedEvent);
    if (!signedEvent) {
      logger.error('scheduleArticle', 'Failed to sign event');
      return null;
    }

    await ScheduledPostService.getInstance().schedule(signedEvent, relays, scheduledAt);
    diagLog('system', 'scheduled_article_submitted', {
      scheduledAt,
      relayCount: relays.length,
      titleLength: title.trim().length,
    });

    EventBus.getInstance().emit('scheduled-posts:changed', {});
    const when = new Date(scheduledAt * 1000).toLocaleString();
    ToastService.show(`Article scheduled for ${when}`, 'success');

    return encodeNaddr({
      kind,
      pubkey: currentUser.pubkey,
      identifier: identifier.trim(),
      relays: relays.slice(0, 2),
    });
  } catch (error) {
    ErrorService.handle(error, 'scheduleArticle', true, 'Failed to schedule article. Please try again.');
    return null;
  }
}
