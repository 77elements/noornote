/**
 * Feedback Board addon runtime.
 *
 * The service is statically imported only here so rollup splits it into this
 * addon's chunk — loaded only when the addon is enabled. The service is a
 * plain singleton without background timers: it acts only when the board view
 * is mounted (fetch on demand) and when actions are published.
 */

import type { AddonContext, AddonRuntime } from '../AddonLoader';
import { FeedbackBoardService } from './FeedbackBoardService';

export class FeedbackBoardRuntime implements AddonRuntime {
  async init(_ctx: AddonContext): Promise<void> {
    // Warm up the singleton (cheap — no network on init).
    FeedbackBoardService.getInstance();
  }

  async destroy(): Promise<void> {
    // No listeners, timers or DOM to unwind — reset the singleton so account
    // switches never leak state.
    FeedbackBoardService.resetInstance();
  }
}

export default new FeedbackBoardRuntime();
