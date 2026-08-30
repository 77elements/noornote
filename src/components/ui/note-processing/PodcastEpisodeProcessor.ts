/**
 * PodcastEpisodeProcessor — kind 30054 (Podcast Draft NIP, parameterized replaceable)
 *
 * A podcast episode published by podcast clients (e.g. Nostr Compass). Tags:
 *   - 'd'         — episode identifier
 *   - 'title'     — episode title
 *   - 'audio'     — [2] audio URL, [3] MIME type (e.g. audio/ogg)
 *   - 'image'     — cover art URL
 *   - 'duration'  — length in seconds
 *   - 'episode' / 'season' — numbering (optional)
 *   - 'pubdate'   — RFC-7231 date (the header shows created_at, so ignored here)
 *
 * `content` holds the markdown shownotes, rendered through the regular text
 * pipeline so mentions/hashtags/links work. The audio block (cover, title,
 * duration, player) is prepended to the content HTML.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote } from '../types/NoteTypes';
import { ContentProcessor } from '../../../services/ContentProcessor';
import {
  escapeHtml,
  escapeHtmlAttr,
  safeHttpUrl,
} from '../../../helpers/escapeHtml';

export class PodcastEpisodeProcessor {
  private static contentProcessor = ContentProcessor.getInstance();

  /**
   * Format a duration in seconds as H:MM:SS or M:SS.
   * 3135 → "52:15", 4035 → "1:07:15", 59 → "0:59"
   */
  static formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const mm = String(h > 0 ? m : m).padStart(h > 0 ? 2 : 1, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  static process(event: NostrEvent): ProcessedNote {
    const eventId = event.id;
    if (!eventId) throw new Error('Event ID is required');

    const get = (name: string): string =>
      event.tags.find(t => t[0] === name)?.[1] ?? '';

    const title = get('title');
    const audioUrl = safeHttpUrl(get('audio'));
    const imageUrl = safeHttpUrl(get('image'));
    const durationSeconds = parseInt(get('duration'), 10);
    const duration =
      Number.isFinite(durationSeconds) && durationSeconds > 0
        ? PodcastEpisodeProcessor.formatDuration(durationSeconds)
        : '';
    const episode = get('episode');
    const season = get('season');

    const processedContent =
      PodcastEpisodeProcessor.contentProcessor.processContentWithTags(
        event.content,
        event.tags
      );

    processedContent.html =
      PodcastEpisodeProcessor.buildEpisodeHtml(
        title,
        audioUrl,
        imageUrl,
        duration,
        episode,
        season
      ) + processedContent.html;

    const authorProfile =
      PodcastEpisodeProcessor.contentProcessor.getNonBlockingProfile(
        event.pubkey
      );

    const result: ProcessedNote = {
      id: eventId,
      type: 'podcast-episode',
      timestamp: event.created_at,
      author: { pubkey: event.pubkey },
      content: processedContent,
      rawEvent: event,
    };

    if (authorProfile) {
      result.author.profile = {
        ...(authorProfile.name !== undefined && { name: authorProfile.name }),
        ...(authorProfile.display_name !== undefined && {
          display_name: authorProfile.display_name,
        }),
        ...(authorProfile.picture !== undefined && {
          picture: authorProfile.picture,
        }),
      };
    }

    return result;
  }

  private static buildEpisodeHtml(
    title: string,
    audioUrl: string | null,
    imageUrl: string | null,
    duration: string,
    episode: string,
    season: string
  ): string {
    const numbering = [
      season ? `Season ${escapeHtml(season)}` : '',
      episode ? `Episode ${escapeHtml(episode)}` : '',
    ]
      .filter(Boolean)
      .join(' · ');

    const cover = imageUrl
      ? `<img class="podcast-episode__cover" src="${escapeHtmlAttr(imageUrl)}" alt="" loading="lazy" />`
      : '<div class="podcast-episode__cover podcast-episode__cover--placeholder" aria-hidden="true">&#x1F399;</div>';

    const player = audioUrl
      ? `<audio class="podcast-episode__player" controls preload="metadata" src="${escapeHtmlAttr(audioUrl)}"></audio>`
      : '';

    const meta: string[] = [];
    if (duration)
      meta.push(
        `<span class="badge badge--warning">${escapeHtml(duration)}</span>`
      );
    if (numbering) meta.push(`<span>${numbering}</span>`);

    return `<div class="podcast-episode">${cover}<div class="podcast-episode__body"><h3>${escapeHtml(title || 'Podcast episode')}</h3>${meta.length > 0 ? `<div class="podcast-episode__meta">${meta.join(' ')}</div>` : ''}${player}</div></div>`;
  }
}
