/**
 * CommunityDefinitionRenderer — Renders Communikeys community definitions
 * (kind 32222).
 *
 * Self-contained: name, description, picture, website and relays live in the
 * event's own tags, so the card renders synchronously — no fetch. Shown in
 * SNV, quotes and reposts; community definitions are deliberately NOT fetched
 * into timelines (metadata event). Card layout mirrors .badge-award.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { NoteStructureBuilder } from './NoteStructureBuilder';
import { UserProfileService } from '../../../services/UserProfileService';
import {
  renderUserMention,
  setupUserMentionHandlers,
} from '../../../helpers/UserMentionHelper';
import { escapeHtml, escapeHtmlAttr } from '../../../helpers/escapeHtml';
import { getTag, getTagValues } from '../../../helpers/tagUtils';
import { _ } from '../../../i18n';

export class CommunityDefinitionRenderer {
  static render(note: ProcessedNote, opts: NoteUIOptions): HTMLElement {
    const { element } = NoteStructureBuilder.build(
      note,
      {
        cssClass: 'note-card--community-definition',
        footerLabel: '',
        renderQuotedNotes: false,
      },
      opts
    );

    const body = element.querySelector('.event-content');
    if (body) {
      body.innerHTML = `<div class="community-card">${CommunityDefinitionRenderer.buildCardInner(
        note.rawEvent
      )}</div>`;
    }

    CommunityDefinitionRenderer.upgradeOwnerLine(element, note.rawEvent);
    return element;
  }

  /** Inline card for quote/naddr previews (no NoteStructureBuilder chrome). */
  static renderInlineCard(event: NostrEvent): HTMLElement {
    const card = document.createElement('div');
    card.className = 'community-card';
    card.innerHTML = CommunityDefinitionRenderer.buildCardInner(event);
    CommunityDefinitionRenderer.upgradeOwnerLine(card, event);
    return card;
  }

  /**
   * Thumb + info fragment WITHOUT the outer `.community-card` wrapper — the
   * wrapper belongs to the caller, otherwise the card ends up double-wrapped.
   */
  private static buildCardInner(event: NostrEvent): string {
    const name =
      getTag(event.tags, 'name') || getTag(event.tags, 'd') || 'Community';
    const description = getTag(event.tags, 'description') || '';
    const picture = getTag(event.tags, 'picture') || undefined;
    const website = getTag(event.tags, 'website') || undefined;
    const relays = getTagValues(event.tags, 'r');

    const descHtml = description
      ? `<div class="community-card__desc">${escapeHtml(
          description.length > 200
            ? `${description.slice(0, 200)}…`
            : description
        )}</div>`
      : '';

    const websiteHtml = website
      ? `<a class="community-card__website" href="${escapeHtmlAttr(
          website
        )}" target="_blank" rel="noopener noreferrer">${escapeHtml(
          website.replace(/^https?:\/\//, '')
        )}</a>`
      : '';

    // NOTE: whitespace-free markup — .event-content uses white-space:pre-wrap,
    // so newlines between tags would render as extra line boxes and stretch
    // the card.
    return [
      `<div class="community-card__thumb">${
        picture
          ? `<img src="${escapeHtmlAttr(picture)}" alt="${escapeHtmlAttr(name)}" loading="lazy" width="64" height="64" />`
          : '<span class="community-card__thumb--emoji">🌐</span>'
      }</div>`,
      '<div class="community-card__info">',
      `<div class="community-card__kicker">${escapeHtml(_('Community'))}</div>`,
      `<div class="community-card__name">${escapeHtml(name)}</div>`,
      CommunityDefinitionRenderer.ownerHtml(event.pubkey),
      descHtml,
      websiteHtml,
      CommunityDefinitionRenderer.relaysHtml(relays),
      '</div>',
    ].join('');
  }

  /**
   * Owner line: mention chip (mini avatar + username) via UserMentionHelper.
   * Sync path renders from the profile cache; without a cached real name the
   * slot stays empty (NEVER show npub/HEX) and is patched async once
   * getUserProfile resolves. On fetch failure the line stays hidden.
   */
  private static ownerHtml(ownerPubkey: string): string {
    const cached =
      UserProfileService.getInstance().getCachedProfile(ownerPubkey);
    if (cached) {
      const name = cached.display_name || cached.name || cached.username || '';
      if (name) {
        return `<div class="community-card__owner">${CommunityDefinitionRenderer.ownerInner(
          ownerPubkey,
          name,
          cached.picture || ''
        )}</div>`;
      }
    }
    return '<div class="community-card__owner"></div>';
  }

  /**
   * Patch the owner slot with the real mention chip once the profile lands.
   * The community's own `r`-tag relays are passed as relay hints — the owner's
   * kind:0 typically lives exactly there (e.g. relay.budabit.club), outside
   * the reader's normal relay set.
   */
  private static upgradeOwnerLine(
    container: HTMLElement,
    event: NostrEvent
  ): void {
    const relayHints = getTagValues(event.tags, 'r').filter(r =>
      /^wss?:\/\//.test(r)
    );
    void UserProfileService.getInstance()
      .getUserProfile(event.pubkey, relayHints.length ? relayHints : undefined)
      .then(profile => {
        const slot = container.querySelector('.community-card__owner');
        if (!slot || !profile) return;
        const name =
          profile.display_name || profile.name || profile.username || '';
        if (!name) return;
        slot.innerHTML = CommunityDefinitionRenderer.ownerInner(
          event.pubkey,
          name,
          profile.picture || ''
        );
        setupUserMentionHandlers(container);
      })
      .catch(() => {
        /* profile unavailable — owner line stays hidden */
      });
  }

  /** "by" label + mention chip (mini avatar + username). */
  private static ownerInner(
    pubkey: string,
    name: string,
    picture: string
  ): string {
    const by = escapeHtml(_('by %s', '')).replace(/%s/g, '').trim();
    const chip = renderUserMention(pubkey, {
      username: name,
      avatarUrl: picture,
    });
    return by ? `${by} ${chip}` : chip;
  }

  private static relaysHtml(relays: string[]): string {
    if (relays.length === 0) return '';
    const shown = relays.slice(0, 3).map(r => r.replace(/^wss?:\/\//, ''));
    const more =
      relays.length > shown.length ? ` +${relays.length - shown.length}` : '';
    return `<div class="community-card__relays">${escapeHtml(
      shown.join(', ') + more
    )}</div>`;
  }
}
