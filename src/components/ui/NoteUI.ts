/**
 * NoteUI Component
 * Single responsibility: Assemble HTML for one note
 * Takes ProcessedNote input, outputs HTMLElement
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';

// Import processors, renderers, and factories
import { NoteProcessor } from './note-processing/NoteProcessor';
import { NoteRendererFactory } from './note-rendering/NoteRendererFactory';
import { NoteStructureBuilder } from './note-rendering/NoteStructureBuilder';
import { CollapsibleManager } from './note-features/CollapsibleManager';
import { FallbackElementFactory } from './note-factories/FallbackElementFactory';
import { InteractionStatusLine } from './InteractionStatusLine';

// Import types for internal use
import type { NoteUIOptions } from './types/NoteTypes';

// Re-export types from central location
export type {
  ProcessedNote,
  MediaContent,
  LinkPreview,
  QuotedReference,
  NoteUIOptions
} from './types/NoteTypes';

export class NoteUI {
  // Maximum nesting depth for quoted notes (prevents infinite recursion)
  private static readonly MAX_NESTING_DEPTH = 2;

  /**
   * Create HTML element for any nostr event (processes content internally)
   * NOW SYNCHRONOUS - returns immediately with skeleton, background tasks update DOM
   * @param event - The Nostr event to render
   * @param options - Rendering options (collapsible, islFetchStats, isLoggedIn, depth)
   * @param index - Optional index for tracking position (legacy compatibility)
   */
  static createNoteElement(event: NostrEvent, options?: NoteUIOptions | number, index?: number): HTMLElement {
    // Legacy compatibility: if options is a number, treat it as index and next param as depth
    let opts: NoteUIOptions;
    if (typeof options === 'number') {
      // Legacy call: createNoteElement(event, index, depth)
      opts = {
        collapsible: true,
        islFetchStats: false,
        isLoggedIn: false,
        headerSize: 'medium',
        depth: index || 0
      };
    } else {
      // New call: createNoteElement(event, options)
      opts = {
        collapsible: true,
        islFetchStats: false,
        isLoggedIn: false,
        headerSize: 'medium',
        depth: 0,
        ...options
      };
    }

    try {
      // Check if we've exceeded maximum nesting depth
      if (opts.depth! > NoteUI.MAX_NESTING_DEPTH) {
        console.warn(`⚠️ Max nesting depth (${NoteUI.MAX_NESTING_DEPTH}) reached for note ${event.id?.slice(0, 8) ?? 'unknown'}`);
        return FallbackElementFactory.createMaxDepthElement(event);
      }

      // Process the event with NoteProcessor (SYNCHRONOUS)
      const note = NoteProcessor.process(event);

      // Render with NoteRendererFactory (delegates to specialized renderers)
      return NoteRendererFactory.render(note, opts);
    } catch (error) {
      console.error('❌ Error processing note:', event.id, error);
      return FallbackElementFactory.createErrorElement(event, error);
    }
  }


  /**
   * Cleanup note headers and ISL for memory management
   * Delegates to NoteStructureBuilder
   */
  static cleanup(noteId: string): void {
    NoteStructureBuilder.cleanup(noteId);
  }

  /**
   * Cleanup all note headers and ISLs
   * Delegates to NoteStructureBuilder
   */
  static cleanupAll(): void {
    NoteStructureBuilder.cleanupAll();
  }

  /**
   * Get InteractionStatusLine instance for a note
   * Used by views to update stats after async operations (e.g., SNV reply count)
   */
  static getInteractionStatusLine(noteId: string): InteractionStatusLine | undefined {
    return NoteStructureBuilder.getISLInstance(noteId);
  }

  /**
   * Setup collapsible for a note
   * PUBLIC - used by QuotedNoteRenderer for quote boxes
   * DELEGATES to CollapsibleManager
   */
  static setupCollapsible(noteElement: HTMLElement): void {
    CollapsibleManager.setup(noteElement);
  }
}