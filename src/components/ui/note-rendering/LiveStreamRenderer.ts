/**
 * LiveStreamRenderer — NIP-53 Live Activity / Live Stream (kind 30311)
 *
 * Renders the kind 30311 event through ArticlePreviewRenderer.createLiveStreamCard
 * (the same pipeline used by naddr quotes), mounted inside the standard note
 * shell produced by NoteStructureBuilder (header + ISL + click-to-SNV).
 *
 * Addon-gated:
 *   - Live Streams Player addon ENABLED → full live-stream card (status badge,
 *     inline HLS player for live streams with a streaming URL, zap-stream
 *     button, chat input).
 *   - addon DISABLED → a compact hint card with a link to /addons/live-streams-player.
 *
 * Top-level 30311 events in the timeline are also gated through here, so the
 * addon boundary is enforced once at the renderer layer.
 */

import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { NoteStructureBuilder } from './NoteStructureBuilder';
import { ArticlePreviewRenderer } from './ArticlePreviewRenderer';
import { isLiveStreamsPlayerEnabled } from '../../../addons/live-streams-player/index';
import { Router } from '../../../services/Router';

export class LiveStreamRenderer {
  static render(note: ProcessedNote, opts: NoteUIOptions): HTMLElement {
    const { element } = NoteStructureBuilder.build(
      note,
      {
        cssClass: 'note-card--live-stream',
        footerLabel: '',
        renderQuotedNotes: false,
      },
      opts
    );

    const host = element.querySelector('.event-content');
    if (!host) return element;

    // The event-content holds the live-stream card. Mark it so SCSS can
    // strip the default text padding when only a card is shown.
    host.classList.add('event-content--live-stream-host');

    if (isLiveStreamsPlayerEnabled()) {
      ArticlePreviewRenderer.getInstance().renderFromEvent(note.rawEvent, host);
    } else {
      LiveStreamRenderer.renderAddonDisabledHint(host as HTMLElement);
    }

    return element;
  }

  /**
   * Compact fallback card shown when the Live Streams Player addon is off.
   * Keeps the note visible in the timeline (header + ISL still work) while
   * nudging the user to enable the addon.
   */
  private static renderAddonDisabledHint(host: HTMLElement): void {
    const card = document.createElement('div');
    card.className = 'live-stream-card live-stream-card--addon-disabled';
    card.innerHTML = `
      <div class="live-stream-card__content">
        <p class="live-stream-card__hint">
          Activate the
          <a class="live-stream-card__hint-link" href="/addons/live-streams-player">Live Streams Player</a>
          addon to see this live stream.
        </p>
      </div>
    `;
    const link = card.querySelector('.live-stream-card__hint-link');
    if (link) {
      link.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        Router.getInstance().navigate('/addons/live-streams-player');
      });
    }
    host.appendChild(card);
  }
}
