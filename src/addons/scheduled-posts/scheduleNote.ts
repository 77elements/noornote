/**
 * Schedule a Kind 1 note (or Kind 1068 poll) for later publishing.
 *
 * Builds the unsigned event, signs it locally via AuthService, and hands it
 * off to the Noornote Scheduler. `created_at` is set to the scheduled moment
 * so relays accept the timestamp when the scheduler publishes at publishAt.
 *
 * Tag-building mirrors PostService.createPost() for behavioural parity. The
 * duplication is intentional: keeping the addon self-contained means removing
 * it leaves the core posting path untouched.
 */

import type { PollData } from '../../components/poll/PollCreator';
import { AuthService } from '../../services/AuthService';
import { SystemLogger } from '../../services/SystemLogger';
import { ErrorService } from '../../services/ErrorService';
import { ToastService } from '../../services/ToastService';
import { TypedEventBus } from '../../core/TypedEventBus';
import { diagLog } from '../../services/DiagnosticLogger';
import { ScheduledPostService } from './ScheduledPostService';

export interface ScheduleNoteOptions {
  content: string;
  relays: string[];
  contentWarning?: boolean;
  pollData?: PollData;
  quotedEvent?: { eventId: string; authorPubkey: string; relayHint?: string };
  quotedArticle?: {
    addressableId: string;
    authorPubkey: string;
    relayHint?: string;
  };
  /** Per-post custom client tag (NIP-89); overrides the global "via NoorNote" UI setting. */
  clientTag?: string;
  /** Unix timestamp when the scheduler should publish the event. */
  scheduledAt: number;
}

const MIN_DELAY_S = 60;
const MAX_DELAY_S = 30 * 24 * 60 * 60;

export async function scheduleNote(
  options: ScheduleNoteOptions
): Promise<boolean> {
  const logger = SystemLogger.getInstance();
  const auth = AuthService.getInstance();
  const {
    relays,
    contentWarning,
    pollData,
    quotedEvent,
    quotedArticle,
    clientTag,
    scheduledAt,
  } = options;

  const { stripTrackingParams } = await import(
    '../../helpers/stripTrackingParams'
  );
  const content = stripTrackingParams(options.content);

  const currentUser = auth.getCurrentUser();
  if (!currentUser) {
    logger.error('scheduleNote', 'User not authenticated');
    return false;
  }

  if (!pollData && (!content || content.trim().length === 0)) {
    logger.error('scheduleNote', 'Content is empty');
    return false;
  }
  if (!relays || relays.length === 0) {
    logger.error('scheduleNote', 'No relays specified');
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (scheduledAt <= now + MIN_DELAY_S) {
    ToastService.show(
      'Scheduled time must be at least 1 minute in the future',
      'error'
    );
    return false;
  }
  if (scheduledAt > now + MAX_DELAY_S) {
    ToastService.show(
      'Scheduled time cannot be more than 30 days in the future',
      'error'
    );
    return false;
  }

  try {
    const tags: string[][] = [];
    const kind = pollData ? 1068 : 1;

    if (contentWarning) tags.push(['content-warning', '']);

    const { extractPubkeysFromText } = await import('../../helpers/nip19');
    const mentionedPubkeys = new Set(extractPubkeysFromText(content));
    mentionedPubkeys.forEach(pubkey => tags.push(['p', pubkey]));

    if (quotedEvent) {
      const qTag = ['q', quotedEvent.eventId];
      if (quotedEvent.relayHint) qTag.push(quotedEvent.relayHint);
      if (quotedEvent.authorPubkey) qTag.push(quotedEvent.authorPubkey);
      tags.push(qTag);
      if (
        quotedEvent.authorPubkey &&
        !mentionedPubkeys.has(quotedEvent.authorPubkey)
      ) {
        tags.push(['p', quotedEvent.authorPubkey]);
      }
    }

    if (quotedArticle) {
      const aTag = ['a', quotedArticle.addressableId];
      if (quotedArticle.relayHint) aTag.push(quotedArticle.relayHint);
      tags.push(aTag);
      if (
        quotedArticle.authorPubkey &&
        !mentionedPubkeys.has(quotedArticle.authorPubkey)
      ) {
        tags.push(['p', quotedArticle.authorPubkey]);
      }
    }

    if (pollData) {
      pollData.options.forEach(option =>
        tags.push(['option', option.id, option.label])
      );
      tags.push([
        'polltype',
        pollData.multipleChoice ? 'multiplechoice' : 'singlechoice',
      ]);
      if (pollData.endDate) tags.push(['endsAt', pollData.endDate.toString()]);
      if (pollData.relayUrls && pollData.relayUrls.length > 0) {
        pollData.relayUrls.forEach(url => tags.push(['relay', url]));
      }
    }

    // Per-post custom client tag (NIP-89) — overrides the global UI setting.
    // AuthService.signEvent skips its own client tag when one is already present.
    if (clientTag && clientTag.trim().length > 0) {
      tags.push(['client', clientTag.trim()]);
    }

    // Custom emoji tags — only when that addon is also enabled
    let finalTags = tags;
    try {
      const { isCustomEmojisEnabled } = await import('../custom-emojis/index');
      if (isCustomEmojisEnabled()) {
        const [{ EmojiService }, { attachEmojiTags }] = await Promise.all([
          import('../custom-emojis/EmojiService'),
          import('../custom-emojis/attachEmojiTags'),
        ]);
        finalTags = attachEmojiTags(
          content,
          tags,
          EmojiService.getInstance().getEmojis()
        );
      }
    } catch (err) {
      logger.warn('scheduleNote', `Custom emoji enrichment skipped: ${err}`);
    }

    const unsignedEvent = {
      kind,
      created_at: scheduledAt,
      tags: finalTags,
      content: content.trim(),
      pubkey: currentUser.pubkey,
    };

    const signedEvent = await auth.signEvent(unsignedEvent);
    if (!signedEvent) {
      logger.error('scheduleNote', 'Failed to sign event');
      return false;
    }

    await ScheduledPostService.getInstance().schedule(
      signedEvent,
      relays,
      scheduledAt
    );
    diagLog('system', 'scheduled_post_submitted', {
      kind,
      scheduledAt,
      relayCount: relays.length,
      contentLength: content.trim().length,
    });

    TypedEventBus.getInstance().emit('scheduled-posts:changed');
    const when = new Date(scheduledAt * 1000).toLocaleString();
    ToastService.show(`Scheduled for ${when}`, 'success');
    return true;
  } catch (error) {
    ErrorService.handle(
      error,
      'scheduleNote',
      true,
      'Failed to schedule post. Please try again.'
    );
    return false;
  }
}
