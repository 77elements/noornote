/**
 * EmojiPackRenderer - Renders a NIP-30 emoji pack (kind 30030) as an nn-card.
 * Card: title + emoji grid + ISL. When the Custom Emojis addon is enabled, it also
 * offers "Add to Collection" (import into your personal pack) or "Edit" (own pack).
 */

import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { NoteHeader } from '../NoteHeader';
import { InteractionStatusLine } from '../InteractionStatusLine';
import {
  parseEmojiPackEvent,
  type EmojiPack,
} from '../../../helpers/parseEmojiPack';
import {
  computeEmojiPackDiffLines,
  getEmojiPackSnapshot,
  setEmojiPackSnapshot,
  snapshotFromEmojiPack,
} from '../../../helpers/emojiPackDiff';
import { getAddressableIdentifier } from '../../../helpers/getAddressableIdentifier';
import { encodeNaddr } from '../../../services/NostrToolsAdapter';
import { Router } from '../../../services/Router';
import { AuthService } from '../../../services/AuthService';
import { ToastService } from '../../../services/ToastService';
import { escapeHtml, escapeHtmlAttr } from '../../../helpers/escapeHtml';
import { isCustomEmojisEnabled } from '../../../addons/custom-emojis/index';

export class EmojiPackRenderer {
  static render(note: ProcessedNote, opts: NoteUIOptions): HTMLElement {
    const event = note.rawEvent;
    const pack = parseEmojiPackEvent(event);

    const element = document.createElement('div');
    element.className = 'note-card note-card--emoji-pack';
    element.dataset.eventId = note.id;

    const naddr = encodeNaddr({
      kind: 30030,
      pubkey: event.pubkey,
      identifier: pack.id,
      relays: [],
    });
    const route = `/note/${naddr}`;

    const noteHeader = new NoteHeader({
      pubkey: event.pubkey,
      eventId: note.id,
      timestamp: note.timestamp,
      rawEvent: event,
      showVerification: true,
      showTimestamp: true,
      showMenu: true,
    });
    element.appendChild(noteHeader.getElement());

    // What-changed sentence (vs the locally cached previous 30030 version).
    const hintLines = buildHintLines(pack);
    if (hintLines.length > 0) {
      const hint = document.createElement('div');
      hint.className = 'emoji-pack-hint';
      if (hintLines.length === 1) {
        hint.textContent = hintLines[0]!;
      } else {
        const ul = document.createElement('ul');
        hintLines.forEach(line => {
          const li = document.createElement('li');
          li.textContent = line;
          ul.appendChild(li);
        });
        hint.appendChild(ul);
      }
      element.appendChild(hint);
    }

    const card = document.createElement('div');
    card.className = 'nn-card nn-card--emoji-pack';
    const grid = pack.emojis
      .map(
        e =>
          `<img class="emoji-pack__emoji" src="${escapeHtmlAttr(e.url)}" alt=":${escapeHtmlAttr(e.shortcode)}:" title=":${escapeHtmlAttr(e.shortcode)}:" loading="lazy" />`
      )
      .join('');
    card.innerHTML = `
      <div class="nn-card__content">
        <h3>${escapeHtml(pack.title)}</h3>
        <div class="emoji-pack__grid">${grid}</div>
        <div class="emoji-pack__actions" data-el="actions"></div>
      </div>
    `;

    // Collection actions — only when the Custom Emojis addon is active.
    if (isCustomEmojisEnabled()) {
      const actions = card.querySelector(
        '[data-el="actions"]'
      ) as HTMLElement | null;
      const isOwn =
        AuthService.getInstance().getCurrentUser()?.pubkey === event.pubkey;
      if (actions && isOwn) {
        const btn = document.createElement('button');
        btn.className = 'btn btn--passive btn--mini';
        btn.type = 'button';
        btn.textContent = 'Edit';
        btn.addEventListener('click', e => {
          e.stopPropagation();
          Router.getInstance().navigate('/addons/custom-emojis');
        });
        actions.appendChild(btn);
      } else if (actions) {
        const btn = document.createElement('button');
        btn.className = 'btn btn--mini';
        btn.type = 'button';
        btn.textContent = 'Add to Collection';
        btn.addEventListener('click', async e => {
          e.stopPropagation();
          btn.disabled = true;
          try {
            const { EmojiService } = await import(
              '../../../addons/custom-emojis/EmojiService'
            );
            const count = await EmojiService.getInstance().importPack(
              pack.emojis
            );
            ToastService.show(
              `Added ${count} custom emoji${count === 1 ? '' : 's'} to your collection`,
              'success'
            );
          } catch {
            ToastService.show('Could not add emojis', 'error');
            btn.disabled = false;
          }
        });
        actions.appendChild(btn);
      }
    }

    card.addEventListener('click', e => {
      const target = e.target as HTMLElement;
      if (target.closest('.note-image--clickable, .note-media, video')) return;
      if (target.closest('button') || target.closest('a')) return;
      Router.getInstance().navigate(route);
    });

    element.appendChild(card);

    const addressableId = getAddressableIdentifier(event);
    const noteId = addressableId || event.id;
    if (noteId) {
      const isl = new InteractionStatusLine({
        noteId,
        authorPubkey: event.pubkey,
        originalEvent: event,
        fetchStats: opts.islFetchStats || false,
        isLoggedIn: opts.isLoggedIn || false,
        ...(event.id ? { articleEventId: event.id } : {}),
      });
      element.appendChild(isl.getElement());
    }

    return element;
  }
}

/**
 * Build the change-description lines for an emoji set, diffing against the
 * locally cached previous version. First encounter falls back to a generic
 * "Emoji set was updated"; same-or-older versions reuse the cached lines.
 * Mirrors FollowPackRenderer.buildHintLines.
 */
function buildHintLines(pack: EmojiPack): string[] {
  if (!pack.authorPubkey || !pack.id) return [];

  const prev = getEmojiPackSnapshot(pack.authorPubkey, pack.id);
  const fallback = ['Emoji set was updated'];

  if (!prev) {
    setEmojiPackSnapshot(
      pack.authorPubkey,
      pack.id,
      snapshotFromEmojiPack(pack)
    );
    return fallback;
  }

  if (pack.createdAt <= prev.createdAt) return prev.diffLines ?? [];

  const diff = computeEmojiPackDiffLines(prev, pack);
  const lines = diff.length > 0 ? diff : fallback;
  const snapshot = snapshotFromEmojiPack(pack);
  snapshot.diffLines = lines;
  setEmojiPackSnapshot(pack.authorPubkey, pack.id, snapshot);
  return lines;
}
