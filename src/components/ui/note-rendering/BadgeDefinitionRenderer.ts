/**
 * BadgeDefinitionRenderer — Renders NIP-58 Badge Definition events (kind 30009).
 *
 * Self-contained (unlike kind-8 awards): name, description, image and thumbs
 * live in the event's own tags, so the card renders synchronously — no
 * definition fetch. Shown in SNV, reposts and quote/naddr previews; badge
 * definitions are deliberately NOT fetched into timelines (metadata event).
 * Card layout reuses .badge-award (plus a kicker label).
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { NoteStructureBuilder } from './NoteStructureBuilder';
import { UserProfileService } from '../../../services/UserProfileService';
import { hexToNpub } from '../../../helpers/nip19';
import { escapeHtml, escapeHtmlAttr } from '../../../helpers/escapeHtml';
import { getTag } from '../../../helpers/tagUtils';
import { _ } from '../../../i18n';

export class BadgeDefinitionRenderer {
  static render(note: ProcessedNote, opts: NoteUIOptions): HTMLElement {
    const { element } = NoteStructureBuilder.build(
      note,
      {
        cssClass: 'note-card--badge-definition',
        footerLabel: '',
        renderQuotedNotes: false,
      },
      opts
    );

    const badgeData = note.badgeData;
    if (badgeData) {
      const body = element.querySelector('.event-content');
      if (body) {
        body.innerHTML = `<div class="badge-award">${BadgeDefinitionRenderer.buildCardInner(
          badgeData.name || badgeData.slug,
          badgeData.description || '',
          badgeData.thumb || badgeData.image,
          note.author.pubkey
        )}</div>`;
      }
    }

    return element;
  }

  /** Inline card for quote/naddr previews (no NoteStructureBuilder chrome). */
  static renderInlineCard(event: NostrEvent): HTMLElement {
    const slug = getTag(event.tags, 'd') || 'badge';
    const card = document.createElement('div');
    card.className = 'badge-award';
    card.innerHTML = BadgeDefinitionRenderer.buildCardInner(
      getTag(event.tags, 'name') || slug,
      getTag(event.tags, 'description') || '',
      getTag(event.tags, 'thumb') || getTag(event.tags, 'image') || undefined,
      event.pubkey
    );
    return card;
  }

  /**
   * Thumb + info fragment WITHOUT the outer `.badge-award` wrapper — the
   * wrapper belongs to the caller (render/renderInlineCard), otherwise the
   * card ends up double-wrapped and stretched.
   */
  private static buildCardInner(
    name: string,
    description: string,
    imageUrl: string | undefined,
    issuerPubkey: string
  ): string {
    const descHtml = description
      ? `<div class="badge-award__desc">${escapeHtml(
          description.length > 200
            ? `${description.slice(0, 200)}…`
            : description
        )}</div>`
      : '';

    // NOTE: whitespace-free markup — .event-content uses white-space:pre-wrap,
    // so newlines between tags would render as extra line boxes and stretch
    // the card.
    return [
      `<div class="badge-award__thumb">${
        imageUrl
          ? `<img src="${escapeHtmlAttr(imageUrl)}" alt="${escapeHtmlAttr(name)}" loading="lazy" width="64" height="64" />`
          : '<span class="badge-award__thumb--emoji">🏅</span>'
      }</div>`,
      '<div class="badge-award__info">',
      `<div class="badge-award__kicker">${escapeHtml(_('Badge'))}</div>`,
      `<div class="badge-award__name">${escapeHtml(name)}</div>`,
      BadgeDefinitionRenderer.issuerHtml(issuerPubkey),
      descHtml,
      '</div>',
    ].join('');
  }

  private static issuerHtml(issuerPubkey: string): string {
    const npub = hexToNpub(issuerPubkey);
    if (!npub) return '';
    const profile =
      UserProfileService.getInstance().getCachedProfile(issuerPubkey);
    const name = UserProfileService.displayNameOf(profile, issuerPubkey);
    return `<div class="badge-award__issuer"><a href="/profile/${npub}" class="mention-link" data-profile-pubkey="${issuerPubkey}">${escapeHtml(
      _('by %s', name)
    )}</a></div>`;
  }
}
