/**
 * PollProcessor - Process kind:1068 poll events (NIP-88)
 * Extracts poll options, multiple choice, end date, relay URLs from tags
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote } from '../types/NoteTypes';
import type { PollData, PollOption } from '../../poll/PollCreator';
import { ContentProcessor } from '../../../services/ContentProcessor';

export class PollProcessor {
  private static contentProcessor = ContentProcessor.getInstance();

  /**
   * Process kind:1068 poll (NIP-88)
   * Extract poll data from tags:
   * - ['option', id, label] - poll options
   * - ['multiple_choice', ''] - allow multiple selections
   * - ['end', timestamp] - poll end date
   * - ['relay', url] - relay URLs
   * SYNCHRONOUS - no blocking calls
   */
  static process(event: NostrEvent): ProcessedNote {
    const authorProfile = PollProcessor.contentProcessor.getNonBlockingProfile(event.pubkey);

    // Process poll question text (event.content)
    const processedContent = PollProcessor.contentProcessor.processContentWithTags(event.content, event.tags);

    // Extract poll data from tags
    const pollData = PollProcessor.extractPollData(event.tags);

    // Build author profile only with defined properties
    const authorData: ProcessedNote['author'] = { pubkey: event.pubkey };
    if (authorProfile) {
      const profile: NonNullable<ProcessedNote['author']['profile']> = {};
      if (authorProfile.name !== undefined) profile.name = authorProfile.name;
      if (authorProfile.display_name !== undefined) profile.display_name = authorProfile.display_name;
      if (authorProfile.picture !== undefined) profile.picture = authorProfile.picture;
      if (Object.keys(profile).length > 0) {
        authorData.profile = profile;
      }
    }

    return {
      id: event.id ?? '',
      type: 'poll',
      timestamp: event.created_at,
      author: authorData,
      content: processedContent,
      pollData,
      rawEvent: event
    };
  }

  /**
   * Extract poll data from event tags (NIP-88)
   */
  static extractPollData(tags: string[][]): PollData {
    const options: PollOption[] = [];
    let multipleChoice = false;
    let endDate: number | undefined;
    const relayUrls: string[] = [];

    tags.forEach(tag => {
      const [tagName, ...values] = tag;

      switch (tagName) {
        case 'option':
          // ['option', id, label]
          if (values.length >= 2 && values[0] && values[1]) {
            options.push({
              id: values[0],
              label: values[1]
            });
          }
          break;
        case 'polltype':
          // ['polltype', 'singlechoice' | 'multiplechoice'] (NIP-88)
          multipleChoice = values[0] === 'multiplechoice';
          break;
        case 'endsAt':
          // ['endsAt', timestamp] (NIP-88)
          if (values[0]) {
            endDate = parseInt(values[0], 10);
          }
          break;
        case 'relay':
          // ['relay', url]
          if (values[0]) {
            relayUrls.push(values[0]);
          }
          break;
      }
    });

    const result: PollData = {
      options,
      multipleChoice
    };
    if (endDate !== undefined) result.endDate = endDate;
    if (relayUrls.length > 0) result.relayUrls = relayUrls;
    return result;
  }
}
