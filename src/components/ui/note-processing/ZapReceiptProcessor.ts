/**
 * ZapReceiptProcessor - Process kind:9735 zap receipts
 * Extracts zap information from NIP-57 zap receipt events
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote, ZapReceiptData } from '../types/NoteTypes';
import { ContentProcessor } from '../../../services/ContentProcessor';

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
    const authorProfile = ZapReceiptProcessor.contentProcessor.getNonBlockingProfile(displayPubkey);

    const result: ProcessedNote = {
      id: eventId,
      type: 'zap-receipt',
      timestamp: event.created_at,
      author: {
        pubkey: displayPubkey
      },
      content: {
        text: zapReceiptData.message || '',
        html: zapReceiptData.message || '',
        media: [],
        links: [],
        hashtags: [],
        quotedReferences: [],
        bolt11Invoices: []
      },
      rawEvent: event,
      zapReceiptData
    };

    if (authorProfile) {
      result.author.profile = {
        name: authorProfile.name,
        display_name: authorProfile.display_name,
        picture: authorProfile.picture
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
    if (descriptionJson) {
      try {
        const zapRequest = JSON.parse(descriptionJson) as NostrEvent;

        // Get message from zap request content
        if (zapRequest.content) {
          message = zapRequest.content;
        }

        // Get sender from zap request if not in P tag
        if (!senderPubkey && zapRequest.pubkey) {
          senderPubkey = zapRequest.pubkey;
        }

        // Get amount from zap request tags (in millisats)
        const amountTag = zapRequest.tags?.find((t: string[]) => t[0] === 'amount');
        if (amountTag?.[1]) {
          amountSats = Math.floor(parseInt(amountTag[1], 10) / 1000);
        }
      } catch {
        // Failed to parse description
      }
    }

    // Fallback: try to extract amount from bolt11 invoice
    if (amountSats === 0 && bolt11) {
      amountSats = ZapReceiptProcessor.extractAmountFromBolt11(bolt11);
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

  /**
   * Extract amount from bolt11 invoice
   * Format: lnbc{amount}{multiplier}...
   */
  private static extractAmountFromBolt11(bolt11: string): number {
    try {
      // Remove lnbc prefix and find amount
      const match = bolt11.toLowerCase().match(/^lnbc(\d+)([munp])?/);
      if (!match || !match[1]) return 0;

      let amount = parseInt(match[1], 10);
      const multiplier = match[2];

      // Convert to sats based on multiplier
      switch (multiplier) {
        case 'm': // milli-bitcoin = 100,000 sats
          amount = amount * 100000;
          break;
        case 'u': // micro-bitcoin = 100 sats
          amount = amount * 100;
          break;
        case 'n': // nano-bitcoin = 0.1 sats
          amount = Math.floor(amount / 10);
          break;
        case 'p': // pico-bitcoin = 0.0001 sats
          amount = Math.floor(amount / 10000);
          break;
        default: // No multiplier = bitcoin
          amount = amount * 100000000;
      }

      return amount;
    } catch {
      return 0;
    }
  }
}
