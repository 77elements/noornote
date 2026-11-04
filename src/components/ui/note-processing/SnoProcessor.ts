/**
 * SnoProcessor — SNO "Simple Nostr Objects" (kind 33331, DECK-0003 draft).
 *
 * Kind 33331 carries a self-contained 3D model in its content JSON (vertices,
 * colours, faces — no external files). This processor validates and parses the
 * payload per DECK-0003 §1.9 and prepends the viewer block; the actual canvas
 * is mounted post-DOM by SnoRenderer. Display-only: NoorNote renders SNO
 * objects, it does not author them.
 *
 * A malformed payload is never rejected silently — DECK-0003 §3.1 asks the
 * client to say why. The card shows the failed rule instead.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote } from '../types/NoteTypes';
import { ContentProcessor } from '../../../services/ContentProcessor';
import { getTag } from '../../../helpers/tagUtils';
import { encodeNaddr } from '../../../services/NostrToolsAdapter';
import { parseSno, type SnoObject } from '../../../helpers/sno/snoParser';
import { _ } from '../../../i18n';
import { escapeHtml } from '../../../helpers/escapeHtml';

export interface SnoData {
  /** Parsed, validated geometry — absent when the payload was refused. */
  object?: SnoObject;
  /** §1.9 refusal, for the error notice (spec §3.1: say why). */
  error?: string;
  name?: string;
  alt?: string;
}

export class SnoProcessor {
  /** Shared content processor for the (usually empty) text body. */
  private static contentProcessor = ContentProcessor.getInstance();

  static process(event: NostrEvent): ProcessedNote {
    const eventId = event.id;
    if (!eventId) throw new Error('Event ID is required');

    const processedContent =
      SnoProcessor.contentProcessor.processContentWithTags(
        event.content,
        event.tags
      );

    const name = getTag(event.tags, 'name') || '';
    const alt = getTag(event.tags, 'alt') || '';
    const parsed = parseSno(event.content);
    const snoData: SnoData = parsed.valid
      ? { object: parsed.object, name, alt }
      : { error: parsed.reason, name, alt };

    // The content IS the model payload, not prose — render the viewer block
    // only, never dump the raw JSON as note text.
    processedContent.html = SnoProcessor.buildViewerBlock(snoData, event);

    return {
      id: eventId,
      type: 'sno-object',
      timestamp: event.created_at,
      author: { pubkey: event.pubkey },
      content: processedContent,
      rawEvent: event,
      snoData,
    };
  }

  /**
   * Viewer block: a stage placeholder the renderer mounts the canvas into,
   * plus name/alt metadata and the snocrash.art workshop link.
   */
  private static buildViewerBlock(snoData: SnoData, event: NostrEvent): string {
    if (snoData.error || !snoData.object) {
      return (
        `<div class="sno" data-sno-state="error">` +
        `<div class="sno__error">${_('Malformed 3D object')}, ${escapeHtml(snoData.error || '')}</div>` +
        `</div>`
      );
    }

    const label = snoData.name || snoData.object.name;
    const meta = `<span class="sno__kicker">${_('3D object')}</span>${
      label ? `<span class="sno__name">${escapeHtml(label)}</span>` : ''
    }`;

    // Workshop link (href only — nothing is fetched automatically). The
    // snocrash.art workshop is the reference viewer for the DECK-0003 format
    // this kind carries.
    const dTag = getTag(event.tags, 'd');
    const workshopUrl =
      dTag &&
      event.kind !== undefined &&
      `https://www.snocrash.art/workshop/${encodeNaddr({
        kind: event.kind,
        pubkey: event.pubkey,
        identifier: dTag,
        relays: [],
      })}`;
    const link = workshopUrl
      ? `<a class="sno__link" href="${escapeHtml(workshopUrl)}" target="_blank" rel="noopener noreferrer">${_('See model on snocrash.art')}</a>`
      : '';

    return (
      `<div class="sno" data-sno-state="ok">` +
      `<div class="sno__stage" data-sno-stage></div>` +
      `<div class="sno__meta">${meta}</div>${
        snoData.alt
          ? `<div class="sno__alt">${escapeHtml(snoData.alt)}</div>`
          : ''
      }${link}</div>`
    );
  }
}
