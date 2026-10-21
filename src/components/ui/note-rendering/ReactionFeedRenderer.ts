/**
 * ReactionFeedRenderer — renders a NIP-25 reaction (kind 7) as a compact,
 * notification-style timeline entry:
 *
 *   [avatar] User X reacted to "First chars of the note…" ❤️
 *
 * The emoji is the reaction's content ('+' or empty → ❤️ per NIP-25).
 * The target note is resolved from the NoteService cache (e-targets) or the
 * articles module (a-targets / articles); clicking the row opens the target.
 * No ISL — the interaction lives on the target note.
 */

import { _ } from '../../../i18n';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { UserProfileService } from '../../../services/UserProfileService';
import { Router } from '../../../services/Router';
import { ModuleLoader } from '../../../core/ModuleLoader';
import type { ArticlesModuleApi } from '../../../modules/articles/contracts';
import { encodeNaddr, encodeNevent } from '../../../services/NostrToolsAdapter';
import { hexToNpub } from '../../../helpers/nip19';
import { escapeHtml } from '../../../helpers/escapeHtml';
import { getTag } from '../../../helpers/tagUtils';

const EXCERPT_LENGTH = 80;

export class ReactionFeedRenderer {
  static render(note: ProcessedNote, _opts: NoteUIOptions): HTMLElement {
    const event = note.rawEvent;
    const element = document.createElement('article');
    element.className = 'note-card reaction-feed-entry';
    element.dataset.eventId = note.id;

    const emoji = this.reactionEmoji(event);
    const elementHtml = `
      <img class="profile-pic profile-pic--mini reaction-feed-entry__avatar" src="" alt="" width="18" height="18" loading="lazy" decoding="async" data-role="reaction-avatar" />
      <p class="reaction-feed-entry__text">
        <a href="/profile/${hexToNpub(event.pubkey)}" class="mention-link" data-profile-pubkey="${event.pubkey}" data-role="reaction-author">…</a>
        reacted to
        <span class="reaction-feed-entry__target pulsate" data-role="reaction-target">${_('Loading…')}</span>
        <span class="reaction-feed-entry__emoji">${escapeHtml(emoji)}</span>
      </p>
    `;
    element.innerHTML = elementHtml;

    void this.fillAuthor(element, event.pubkey);
    void this.fillTarget(element, event);

    return element;
  }

  /** NIP-25: '+' or empty content means a default heart like. */
  private static reactionEmoji(event: NostrEvent): string {
    const content = (event.content || '').trim();
    if (!content || content === '+') return '❤️';
    return content;
  }

  private static async fillAuthor(
    element: HTMLElement,
    pubkey: string
  ): Promise<void> {
    const authorEl = element.querySelector('[data-role="reaction-author"]');
    if (!authorEl) return;
    const npub = hexToNpub(pubkey) || pubkey;
    try {
      const profile =
        await UserProfileService.getInstance().getUserProfile(pubkey);
      const username =
        profile?.name || profile?.display_name || `${npub.slice(0, 12)}...`;
      authorEl.textContent = username;
      const pic = element.querySelector(
        '[data-role="reaction-avatar"]'
      ) as HTMLImageElement | null;
      if (pic && profile?.picture) pic.src = profile.picture;
    } catch {
      authorEl.textContent = `${npub.slice(0, 12)}...`;
    }
  }

  /**
   * Resolve the reacted-to note: e-targets from the NoteService cache or a
   * relay fetch, a-targets (articles) through the articles module. Clicking
   * the row navigates to the target once resolved.
   */
  private static async fillTarget(
    element: HTMLElement,
    event: NostrEvent
  ): Promise<void> {
    const targetEl = element.querySelector('[data-role="reaction-target"]');
    if (!targetEl) return;

    const eTag = (event.tags || []).find(
      t => t[0] === 'e' && t[1] && /^[0-9a-f]{64}$/i.test(t[1])
    );
    const aTag = (event.tags || []).find(t => t[0] === 'a' && t[1]);

    let url: string | null = null;
    let excerpt = '';

    if (eTag?.[1]) {
      const targetId = eTag[1];
      url = `/note/${encodeNevent(targetId)}`;
      const target = await this.fetchETarget(targetId);
      excerpt = target ? this.excerptOf(target) : '';
    } else if (aTag?.[1]) {
      const parts = aTag[1].split(':');
      if (parts.length >= 3) {
        const kind = Number(parts[0]);
        const pubkey = parts[1] ?? '';
        const identifier = parts.slice(2).join(':');
        if (!pubkey || !identifier || !Number.isFinite(kind)) return;
        const naddr = encodeNaddr({
          kind,
          pubkey,
          identifier,
          relays: [],
        });
        url = `/article/${naddr}`;
        const articlesApi =
          ModuleLoader.getInstance().getApi<ArticlesModuleApi>('articles');
        const target =
          (await articlesApi?.fetchAddressableEvent(naddr)) ?? null;
        excerpt = target ? this.excerptOf(target) : '';
      }
    }

    if (!url) {
      targetEl.textContent = 'a note';
      targetEl.classList.remove('pulsate');
      return;
    }

    targetEl.classList.remove('pulsate');
    targetEl.textContent = excerpt ? `"${excerpt}"` : 'a note';

    element.style.cursor = 'pointer';
    element.addEventListener('click', (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('a')) return;
      Router.getInstance().navigate(url as string);
    });
  }

  private static async fetchETarget(
    targetId: string
  ): Promise<NostrEvent | null> {
    // Cache first (the target is usually already on screen), relay fallback.
    const { fetchNostrEvents } = await import(
      '../../../services/FetchNostrEvents'
    );
    const relayConfig = (
      await import('../../../services/RelayConfig')
    ).RelayConfig.getInstance();
    try {
      const result = await fetchNostrEvents({
        relays: relayConfig.getReadRelays(),
        ids: [targetId],
        limit: 1,
      });
      return result.events[0] ?? null;
    } catch {
      return null;
    }
  }

  private static excerptOf(target: NostrEvent): string {
    const title = getTag(target.tags, 'title');
    const base =
      title ||
      (target.content || '')
        .replace(/^#+\s.*/gm, '')
        .replace(/!\[.*?\]\(.*?\)/g, '')
        .replace(/\[([^\]]+)\]\(.*?\)/g, '$1')
        .replace(/[*_~`>#]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!base) return '';
    return base.length <= EXCERPT_LENGTH
      ? base
      : `${base.slice(0, EXCERPT_LENGTH).replace(/\s+\S*$/, '')}…`;
  }
}
