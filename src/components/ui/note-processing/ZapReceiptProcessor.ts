/**
 * ZapReceiptProcessor - Process kind:9735 zap receipts
 * Extracts zap information from NIP-57 zap receipt events
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote, ZapReceiptData } from '../types/NoteTypes';
import { ContentProcessor } from '../../../services/ContentProcessor';
import { parseBolt11Amount } from '../../../helpers/zapUtils';

export class ZapReceiptProcessor {
  private static contentProcessor = ContentProcessor.getInstance();

  /**
   * Process kind:9735 zap receipt
   * SYNCHRONOUS - no blocking calls
   */
  static process(event: NostrEvent): ProcessedNote {
    const eventId = event.id;
    if (!eventId) {
      throw new Error('Event ID is required');
    }

    // Extract zap receipt data from tags
    const zapReceiptData = ZapReceiptProcessor.extractZapData(event);

    // The "author" of a zap receipt is the LNURL provider, not the sender
    // We use the sender from zapReceiptData for display
    const displayPubkey = zapReceiptData.senderPubkey || event.pubkey;
    const authorProfile =
      ZapReceiptProcessor.contentProcessor.getNonBlockingProfile(displayPubkey);

    const result: ProcessedNote = {
      id: eventId,
      type: 'zap-receipt',
      timestamp: event.created_at,
      author: {
        pubkey: displayPubkey,
      },
      content: {
        text: zapReceiptData.message || '',
        html: zapReceiptData.message || '',
        media: [],
        links: [],
        hashtags: [],
        quotedReferences: [],
        bolt11Invoices: [],
      },
      rawEvent: event,
      zapReceiptData,
    };

    if (authorProfile) {
      result.author.profile = {
        ...(authorProfile.name !== undefined && { name: authorProfile.name }),

        ...(authorProfile.display_name !== undefined && {
          display_name: authorProfile.display_name,
        }),

        ...(authorProfile.picture !== undefined && {
          picture: authorProfile.picture,
        }),
      };
    }

    return result;
  }

  /**
   * Extract zap data from event tags
   */
  private static extractZapData(event: NostrEvent): ZapReceiptData {
    const tags = event.tags;

    // Get recipient pubkey (p tag)
    const pTag = tags.find(t => t[0] === 'p');
    const recipientPubkey = pTag?.[1] || event.pubkey;

    // Get sender pubkey (P tag - uppercase)
    const senderTag = tags.find(t => t[0] === 'P');
    let senderPubkey = senderTag?.[1];

    // Get target event (e tag)
    const eTag = tags.find(t => t[0] === 'e');
    const targetEventId = eTag?.[1];

    // Get bolt11 invoice to extract amount
    const bolt11Tag = tags.find(t => t[0] === 'bolt11');
    const bolt11 = bolt11Tag?.[1] || '';

    // Get description (JSON-encoded zap request)
    const descTag = tags.find(t => t[0] === 'description');
    const descriptionJson = descTag?.[1];

    let message = '';
    let amountSats = 0;

    // Parse the embedded zap request (kind 9734)
    let isAnon = false;
    if (descriptionJson) {
      try {
        const zapRequest = JSON.parse(descriptionJson) as NostrEvent;

        // Get message from zap request content
        if (zapRequest.content) {
          message = zapRequest.content;
        }

        // Detect anonymous zaps (PR #1271 / Damus / Amethyst / Wisp convention).
        // The pubkey on the embedded request is an ephemeral throwaway — not a
        // real user — so we drop senderPubkey and let the renderer's existing
        // "Anonymous" fallback take over.
        isAnon =
          Array.isArray(zapRequest.tags) &&
          zapRequest.tags.some((t: string[]) => t[0] === 'anon');

        // Get sender from zap request if not in P tag (skip for anon zaps)
        if (!senderPubkey && zapRequest.pubkey && !isAnon) {
          senderPubkey = zapRequest.pubkey;
        }

        // Get amount from zap request tags (in millisats)
        const amountTag = zapRequest.tags?.find(
          (t: string[]) => t[0] === 'amount'
        );
        if (amountTag?.[1]) {
          amountSats = Math.floor(parseInt(amountTag[1], 10) / 1000);
        }
      } catch {
        // Failed to parse description
      }
    }

    // If the zap is anonymous, strip the ephemeral P tag too — caller should
    // see "no sender" so its Anonymous fallback paths fire consistently.
    if (isAnon) {
      senderPubkey = undefined;
    }

    // Fallback: try to extract amount from bolt11 invoice
    if (amountSats === 0 && bolt11) {
      amountSats = parseBolt11Amount(bolt11);
    }

    const result: ZapReceiptData = {
      amountSats,
      recipientPubkey,
    };
    if (senderPubkey) result.senderPubkey = senderPubkey;
    if (message) result.message = message;
    if (targetEventId) result.targetEventId = targetEventId;

    return result;
  }
}
