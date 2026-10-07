/**
 * NsiteRenderer — Full note card for NIP-5A static websites (nsites).
 *
 * NIP-5A (draft) hosts static websites on Blossom: a manifest event maps URL
 * paths to sha256 blob hashes (`["path", "/index.html", "<hash>"]`), plus
 * optional `title` / `description` / `server` / `source` tags and an `x`
 * aggregate hash. The body is always empty — a nsite is not readable content,
 * it is a file listing. The card shows the site identity (title, description,
 * file count — no file listing), a link to a public gateway and, when
 * present, the source repo + aggregate hash.
 *
 * Built on the shared note shell (NoteStructureBuilder) so nsites get the
 * author header, full 3-dot menu, ISL (like/zap/repost/comment) and
 * click-through to SNV exactly like every other supported kind.
 *
 * Routing: kind 15128 always; kind 35128 only with the NIP-5A-mandatory
 * `path` tags (shared with Satellite Earth — see NsiteProcessor).
 *
 * The gateway/source links are plain external anchors opened by the user —
 * no automatic fetch (privacy: zero outbound calls).
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { NoteStructureBuilder } from './NoteStructureBuilder';
import { NSITE_NAMED_KIND } from '../note-processing/NsiteProcessor';
import { hexToNpub } from '../../../helpers/nip19';
import { getTag } from '../../../helpers/tagUtils';
import { escapeHtml, escapeHtmlAttr } from '../../../helpers/escapeHtml';
import { ClipboardActionsService } from '../../../services/ClipboardActionsService';

// NIP-5A canonical gateway label: npub for root, base36(pubkey)+dTag for named.
function buildNsiteUrl(event: NostrEvent): string {
  if (!event.pubkey) return '';
  if (event.kind === NSITE_NAMED_KIND) {
    const base36 = BigInt(`0x${event.pubkey}`).toString(36);
    const dTag = getTag(event.tags, 'd') || '';
    return `https://${base36}${dTag}.nsite.run/`;
  }
  const npub = hexToNpub(event.pubkey);
  return npub ? `https://${npub}.nsite.run/` : '';
}

export class NsiteRenderer {
  static render(note: ProcessedNote, opts: NoteUIOptions): HTMLElement {
    const { element } = NoteStructureBuilder.build(
      note,
      {
        cssClass: 'note-card--nsite',
        footerLabel: '',
        renderQuotedNotes: false,
      },
      opts
    );

    const body = element.querySelector('.event-content');
    if (body) {
      body.innerHTML = NsiteRenderer.buildCardHtml(note.rawEvent);
      NsiteRenderer.wireCardActions(body as HTMLElement, note.rawEvent);
    }

    return element;
  }

  private static buildCardHtml(event: NostrEvent): string {
    const title = getTag(event.tags, 'title')?.trim() || 'Nostr website';
    const description = getTag(event.tags, 'description')?.trim();
    const source = getTag(event.tags, 'source')?.trim();
    const aggregateHash = event.tags.find(t => t[0] === 'x')?.[1];
    const paths = event.tags.filter(t => t[0] === 'path' && t[1]);
    const url = buildNsiteUrl(event);

    return `
      <div class="nsite-card">
        <div class="nsite-card__title">🌐 nsite · ${escapeHtml(title)}</div>
        ${description ? `<div class="nsite-card__description">${escapeHtml(description)}</div>` : ''}
        <div class="nsite-card__meta">NIP-5A static website · ${paths.length} file${paths.length === 1 ? '' : 's'} on Blossom servers</div>
        <div class="nsite-card__actions">
          ${
            url
              ? `<a href="${escapeHtmlAttr(url)}" target="_blank" rel="noopener noreferrer" class="btn btn--medium">↗ Open website</a>`
              : ''
          }
          ${
            source && /^https?:\/\//.test(source)
              ? `<a href="${escapeHtmlAttr(source)}" target="_blank" rel="noopener noreferrer" class="btn btn--passive btn--medium">Source code ↗</a>`
              : ''
          }
        </div>
        ${
          aggregateHash
            ? `<div class="nsite-card__hash">
                <span class="nsite-card__hash-value">${escapeHtml(aggregateHash.slice(0, 16))}…</span>
                <button class="btn-icon nsite-card__hash-copy" data-hash="${escapeHtmlAttr(aggregateHash)}" aria-label="Copy site hash" title="Copy full aggregate hash">
                  <svg width="14" height="14"><use href="#icon-copy"/></svg>
                </button>
              </div>`
            : ''
        }
      </div>
    `;
  }

  /** Wire the aggregate-hash copy button (a plain button action, no card nav). */
  private static wireCardActions(body: HTMLElement, _event: NostrEvent): void {
    const copyBtn = body.querySelector(
      '.nsite-card__hash-copy'
    ) as HTMLButtonElement | null;
    if (!copyBtn) return;

    copyBtn.addEventListener('click', e => {
      e.stopPropagation();
      const hash = copyBtn.dataset.hash;
      if (!hash) return;
      const clipboard = ClipboardActionsService.getInstance();
      void clipboard
        .copyText(hash, 'Site hash')
        .then(ok => {
          if (ok) clipboard.addVisualFeedback(copyBtn);
        })
        .catch(() => {
          /* toast already shown by copyText on failure */
        });
    });
  }
}
