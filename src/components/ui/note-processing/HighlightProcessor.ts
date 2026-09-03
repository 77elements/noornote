/**
 * HighlightProcessor — NIP-84 Highlight (kind 9802)
 *
 * `event.content` is the highlighted passage. The source of the passage is
 * referenced via tags, in the priority order specified by NIP-84:
 *   1. tag with [2] === 'source' (explicit marker, any tag type)
 *   2. 'e' tag — Nostr Note (kind 1, etc.)
 *   3. 'a' tag — addressable event (article, long-form)
 *   4. 'r' tag — external URL
 *
 * Optional tags:
 *   - 'comment' — the highlighter's own remark (rendered above the quote)
 *   - 'p' with [3] === 'author' — the source author's pubkey
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote } from '../types/NoteTypes';
import { ContentProcessor } from '../../../services/ContentProcessor';
import { buildProcessedNote } from './processedNoteFactory';
import { encodeNevent, encodeNaddr } from '../../../services/NostrToolsAdapter';
import { hexToNpub } from '../../../helpers/nip19';
import { npubToUsername } from '../../../helpers/npubToUsername';
import { escapeHtml, escapeHtmlAttr } from '../../../helpers/escapeHtml';

interface SourceLink {
  href: string;
  label: string;
  external: boolean;
}

export class HighlightProcessor {
  private static contentProcessor = ContentProcessor.getInstance();

  static process(event: NostrEvent): ProcessedNote {
    const sourceTag = HighlightProcessor.extractSourceTag(event.tags);
    const sourceAuthorPubkey = HighlightProcessor.extractSourceAuthor(
      event.tags
    );
    const commentValue = event.tags.find(t => t[0] === 'comment')?.[1];

    const processedComment = commentValue
      ? HighlightProcessor.contentProcessor.processContentWithTags(
          commentValue,
          event.tags
        )
      : null;

    const html = HighlightProcessor.buildHighlightHtml(
      event.content,
      processedComment?.html,
      sourceTag,
      sourceAuthorPubkey
    );

    return buildProcessedNote(event, {
      type: 'highlight',
      content: {
        text: event.content,
        html,
        media: processedComment?.media ?? [],
        links: processedComment?.links ?? [],
        hashtags: processedComment?.hashtags ?? [],
        quotedReferences: processedComment?.quotedReferences ?? [],
        bolt11Invoices: processedComment?.bolt11Invoices ?? [],
      },
    });
  }

  private static extractSourceTag(tags: string[][]): string[] | null {
    const explicit = tags.find(t => t[2] === 'source');
    if (explicit) return explicit;
    const eTag = tags.find(t => t[0] === 'e');
    if (eTag) return eTag;
    const aTag = tags.find(t => t[0] === 'a');
    if (aTag) return aTag;
    const rTag = tags.find(t => t[0] === 'r');
    return rTag ?? null;
  }

  private static extractSourceAuthor(tags: string[][]): string | null {
    const authorTag = tags.find(t => t[0] === 'p' && t[3] === 'author');
    if (authorTag?.[1]) return authorTag[1];
    const firstP = tags.find(t => t[0] === 'p');
    return firstP?.[1] ?? null;
  }

  private static resolveSourceLink(
    sourceTag: string[] | null
  ): SourceLink | null {
    if (!sourceTag) return null;

    if (sourceTag[0] === 'r' && sourceTag[1]) {
      return { href: sourceTag[1], label: sourceTag[1], external: true };
    }

    if (
      (sourceTag[0] === 'e' || sourceTag[2] === 'source') &&
      sourceTag[1] &&
      /^[0-9a-f]{64}$/i.test(sourceTag[1])
    ) {
      const nevent = encodeNevent(sourceTag[1]);
      return { href: `/note/${nevent}`, label: 'note', external: false };
    }

    if (sourceTag[0] === 'a' && sourceTag[1]) {
      const [kindStr, pubkey, identifier] = sourceTag[1].split(':');
      const kind = parseInt(kindStr || '');
      if (!Number.isNaN(kind) && pubkey && identifier !== undefined) {
        if (kind === 30023) {
          const naddr = encodeNaddr({ kind, pubkey, identifier, relays: [] });
          return {
            href: `/article/${naddr}`,
            label: 'article',
            external: false,
          };
        }
        return { href: '#', label: 'event', external: false };
      }
    }

    return null;
  }

  private static buildHighlightHtml(
    highlightedText: string,
    commentHtml: string | undefined,
    sourceTag: string[] | null,
    sourceAuthorPubkey: string | null
  ): string {
    const parts: string[] = [];
    parts.push('<div class="highlight">');

    if (commentHtml) {
      parts.push(`<div class="highlight__comment">${commentHtml}</div>`);
    }

    parts.push(
      `<blockquote class="highlight__quote">${escapeHtml(highlightedText)}</blockquote>`
    );

    const sourceLink = HighlightProcessor.resolveSourceLink(sourceTag);
    const authorMarkup =
      HighlightProcessor.renderSourceAuthor(sourceAuthorPubkey);

    if (sourceLink || authorMarkup) {
      const linkMarkup = sourceLink
        ? `<a href="${escapeHtmlAttr(sourceLink.href)}" class="highlight__source-link"${
            sourceLink.external
              ? ' target="_blank" rel="noopener noreferrer"'
              : ''
          }>${escapeHtml(sourceLink.label)}</a>`
        : '';

      const sep = linkMarkup && authorMarkup ? ' by ' : '';
      parts.push(
        `<div class="highlight__source">From ${linkMarkup}${sep}${authorMarkup}</div>`
      );
    }

    parts.push('</div>');
    return parts.join('');
  }

  private static renderSourceAuthor(pubkey: string | null): string {
    if (!pubkey) return '';
    const npub = hexToNpub(pubkey);
    if (!npub) return '';
    const username = npubToUsername(npub);
    return `<span class="user-mention" data-pubkey="${pubkey}"><a href="/profile/${npub}" class="mention-link" data-profile-pubkey="${pubkey}">${escapeHtml(username)}</a></span>`;
  }
}
