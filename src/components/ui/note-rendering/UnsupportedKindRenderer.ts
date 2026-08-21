/**
 * UnsupportedKindRenderer - Renders fallback for unknown event kinds
 * Shows "Unsupported event kind X" with "Open in another client" button
 */

import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { encodeNevent, encodeNaddr } from '../../../services/NostrToolsAdapter';
import { escapeHtml } from '../../../helpers/escapeHtml';
import { formatGroupChatContent } from '../../../helpers/formatGroupChatContent';
import { DittoFeatureRenderer, DITTO_GEOCACHE_KIND } from './DittoFeatureRenderer';
import { SatelliteSiteRenderer, SATELLITE_SITE_KIND } from './SatelliteSiteRenderer';
import { ArmadaInviteRenderer } from './ArmadaInviteRenderer';

/** Armada / Concord encrypted community invite bundle (CORD-05). */
const ARMADA_INVITE_KIND = 33301;
/** NIP-29 group chat message — rendered as readable text, not "unsupported". */
const GROUP_CHAT_KIND = 9;

export class UnsupportedKindRenderer {
  /**
   * Render unsupported kind fallback element
   */
  static render(note: ProcessedNote, _opts: NoteUIOptions): HTMLElement {
    // Ditto geocache (kind 37516): show a dedicated "open in Ditto" notice
    // instead of a generic "unsupported kind" + njump link.
    if (note.rawEvent.kind === DITTO_GEOCACHE_KIND) {
      return DittoFeatureRenderer.render(note.rawEvent);
    }
    // Satellite Earth personal-site page (kind 35129): dedicated "open on
    // Satellite Earth" notice with the page title from the title tag.
    if (note.rawEvent.kind === SATELLITE_SITE_KIND) {
      return SatelliteSiteRenderer.render(note.rawEvent);
    }
    // Armada invite bundle reached as a raw event (rare — normally the
    // addressable-quote path intercepts it via QuotedNoteRenderer's
    // kind-33301 branch before we land here). No URL fragment is available
    // on the raw event, so this is the static "Encrypted community" card.
    if (note.rawEvent.kind === ARMADA_INVITE_KIND) {
      return ArmadaInviteRenderer.renderFromEvent(note.rawEvent);
    }
    // NIP-29 group chat message (lives on group relays, not renderable here):
    // show the message text with a "Group chat" prefix instead of a bare
    // "unsupported kind" card. No "open in another client" button — jump
    // clients don't render kind 9 either.
    if (note.rawEvent.kind === GROUP_CHAT_KIND) {
      const content = formatGroupChatContent(note.rawEvent.content || '');
      const maxLength = 280;
      const snippet = content.length > maxLength ? content.slice(0, maxLength) + '…' : content;
      const element = document.createElement('div');
      element.className = 'note-card note-card--unsupported';
      if (note.id) element.dataset.eventId = note.id;
      element.innerHTML = `
        <div class="unsupported-kind">
          <div class="unsupported-kind__message">
            ${snippet ? `Group chat: ${escapeHtml(snippet)}` : 'Group chat'}
          </div>
        </div>
      `;
      return element;
    }

    const element = document.createElement('div');
    element.className = 'note-card note-card--unsupported';
    if (note.id) element.dataset.eventId = note.id;

    const kind = note.rawEvent.kind;
    const nevent = note.id ? encodeNevent(note.id) : '';
    const njumpUrl = nevent ? `https://njump.me/${nevent}` : '';

    element.innerHTML = `
      <div class="unsupported-kind">
        <div class="unsupported-kind__message">
          Unsupported event kind ${kind}
        </div>
        ${njumpUrl ? `
          <a href="${njumpUrl}" target="_blank" rel="noopener noreferrer" class="btn">
            ↗ Open in another client
          </a>
        ` : ''}
      </div>
    `;

    return element;
  }

  /**
   * Render the same fallback straight from a decoded naddr coordinate — used by
   * the addressable-quote routing, which only has the coordinate (no fetched
   * event). Keeps addressable events that aren't a supported kind (e.g. a
   * proprietary community kind) out of the article renderer: same card, "open in
   * another client" points at the naddr on njump. Ditto geocache and Satellite
   * Earth site pages keep their own dedicated notice.
   */
  static renderFromCoordinate(kind: number, pubkey: string, identifier: string): HTMLElement {
    if (kind === DITTO_GEOCACHE_KIND) {
      return DittoFeatureRenderer.renderFromCoordinate(kind, pubkey, identifier);
    }
    if (kind === SATELLITE_SITE_KIND) {
      return SatelliteSiteRenderer.renderFromCoordinate(kind, pubkey, identifier);
    }
    // Armada invite bundle as a coordinate fallback (no fragment available —
    // static card). QuotedNoteRenderer normally intercepts kind 33301 before
    // we reach this branch.
    if (kind === ARMADA_INVITE_KIND) {
      // Reconstruct the naddr; ArmadaInviteRenderer.renderFromCoordinate handles it.
      const naddr = encodeNaddr({ kind, pubkey, identifier, relays: [] });
      return ArmadaInviteRenderer.renderFromCoordinate(naddr, undefined);
    }

    const element = document.createElement('div');
    element.className = 'note-card note-card--unsupported';

    const naddr = encodeNaddr({ kind, pubkey, identifier, relays: [] });
    const njumpUrl = `https://njump.me/${naddr}`;

    element.innerHTML = `
      <div class="unsupported-kind">
        <div class="unsupported-kind__message">
          Unsupported event kind ${kind}
        </div>
        <a href="${njumpUrl}" target="_blank" rel="noopener noreferrer" class="btn">
          ↗ Open in another client
        </a>
      </div>
    `;

    return element;
  }
}
