/**
 * BadgeAwardRenderer — Renders NIP-58 Badge Award events (kind 8).
 *
 * Shows a compact badge card: thumbnail + name + description + awardee count.
 * The badge definition (kind:30009) is fetched async via BadgeOrchestrator —
 * the card starts with the slug as placeholder and upgrades once the
 * definition arrives.
 */

import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { NoteStructureBuilder } from './NoteStructureBuilder';
import { UserProfileService } from '../../../services/UserProfileService';
import { hexToNpub } from '../../../helpers/nip19';
import { escapeHtml, escapeHtmlAttr } from '../../../helpers/escapeHtml';

export class BadgeAwardRenderer {
  static render(note: ProcessedNote, opts: NoteUIOptions): HTMLElement {
    const { element } = NoteStructureBuilder.build(note, {
      cssClass: 'note-card--badge-award',
      footerLabel: '',
      renderQuotedNotes: false,
    }, opts);

    const badgeData = note.badgeData;
    if (badgeData) {
      const body = element.querySelector('.event-content');
      if (body) {
        body.innerHTML = BadgeAwardRenderer.buildSkeletonHtml(badgeData.slug, badgeData.awardees);
        BadgeAwardRenderer.upgradeWithDefinition(body as HTMLElement, badgeData.coordinate);
        BadgeAwardRenderer.upgradeAwardeeNames(body as HTMLElement, badgeData.awardees);
      }
    }

    return element;
  }

  static renderInlineCard(event: import('@nostr-dev-kit/ndk').NostrEvent): HTMLElement {
    const aTag = event.tags.find(t => t[0] === 'a');
    const coordinate = aTag?.[1] ?? '';
    const parts = coordinate.split(':');
    const slug = parts.length >= 3 ? parts.slice(2).join(':') : 'badge';
    const awardees = event.tags.filter(t => t[0] === 'p' && t[1]).map(t => t[1]!) as string[];

    const card = document.createElement('div');
    card.className = 'badge-award-card';
    card.innerHTML = BadgeAwardRenderer.buildSkeletonHtml(slug, awardees);

    BadgeAwardRenderer.upgradeWithDefinition(card, coordinate);
    BadgeAwardRenderer.upgradeAwardeeNames(card, awardees);

    return card;
  }

  private static buildSkeletonHtml(slug: string, awardees: string[]): string {
    const awardeeCount = awardees.length;
    const countLabel = awardeeCount === 1 ? '1 recipient' : `${awardeeCount} recipients`;

    return `<div class="badge-award">
      <div class="badge-award__thumb"></div>
      <div class="badge-award__info">
        <div class="badge-award__name">${escapeHtml(slug)}</div>
        <div class="badge-award__desc"></div>
        <div class="badge-award__awardees">${escapeHtml(countLabel)}</div>
      </div>
    </div>`;
  }

  private static upgradeWithDefinition(container: HTMLElement, coordinate: string): void {
    if (!coordinate) return;
    import('../../../services/orchestration/BadgeOrchestrator').then(({ BadgeOrchestrator }) =>
    BadgeOrchestrator.getInstance().fetchBadgeDefinition(coordinate)).then(def => {
      if (!def) return;
      const nameEl = container.querySelector('.badge-award__name');
      if (nameEl) nameEl.textContent = def.name;

      const descEl = container.querySelector('.badge-award__desc');
      if (descEl && def.description) {
        const truncated = def.description.length > 120
          ? def.description.slice(0, 120) + '…'
          : def.description;
        descEl.textContent = truncated;
      }

      const thumbEl = container.querySelector('.badge-award__thumb') as HTMLElement;
      if (thumbEl) {
        const imgUrl = def.thumb || def.image;
        if (imgUrl) {
          thumbEl.innerHTML = `<img src="${escapeHtmlAttr(imgUrl)}" alt="${escapeHtmlAttr(def.name)}" loading="lazy" />`;
        } else {
          thumbEl.textContent = '🏅';
          thumbEl.classList.add('badge-award__thumb--emoji');
        }
      }

      const issuerNpub = hexToNpub(def.issuerPubkey);
      if (issuerNpub) {
        const nameDisplay = container.querySelector('.badge-award__name');
        if (nameDisplay && !container.querySelector('.badge-award__issuer')) {
          const issuerEl = document.createElement('div');
          issuerEl.className = 'badge-award__issuer';
          const profile = UserProfileService.getInstance().getCachedProfile(def.issuerPubkey);
          const issuerName = UserProfileService.displayNameOf(profile, def.issuerPubkey);
          issuerEl.innerHTML = `by <a href="/profile/${issuerNpub}" class="mention-link" data-profile-pubkey="${def.issuerPubkey}">${escapeHtml(issuerName)}</a>`;
          nameDisplay.insertAdjacentElement('afterend', issuerEl);
        }
      }
    }).catch(() => { /* definition not found — slug stays as fallback */ });
  }

  private static upgradeAwardeeNames(container: HTMLElement, awardees: string[]): void {
    if (awardees.length === 0) return;
    const awardeesEl = container.querySelector('.badge-award__awardees');
    if (!awardeesEl) return;

    const profileService = UserProfileService.getInstance();
    const MAX_SHOWN = 3;
    const shown = awardees.slice(0, MAX_SHOWN);

    Promise.all(shown.map(pk => profileService.getUserProfile(pk))).then(profiles => {
      const parts: string[] = [];
      for (let i = 0; i < shown.length; i++) {
        const pk = shown[i]!;
        const npub = hexToNpub(pk);
        const name = UserProfileService.displayNameOf(profiles[i] ?? null, pk);
        if (npub) {
          parts.push(`<a href="/profile/${npub}" class="mention-link" data-profile-pubkey="${pk}">${escapeHtml(name)}</a>`);
        }
      }
      const remaining = awardees.length - MAX_SHOWN;
      if (remaining > 0) parts.push(`+${remaining} more`);
      awardeesEl.innerHTML = `Awarded to ${parts.join(', ')}`;
    }).catch(() => { /* keep count-only fallback */ });
  }
}
