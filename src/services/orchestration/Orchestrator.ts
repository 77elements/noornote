/**
 * Orchestrator - Abstract Base Class (Gossip Pattern)
 * All event orchestrators extend this class
 *
 * Pattern: Components → Orchestrators → Router → Transport → Relays
 *
 * Each orchestrator:
 * - Handles a specific event domain (Feed, Reactions, Thread, Profile, etc.)
 * - Registers filters with the Router
 * - Receives events via onmessage()
 * - Distributes to interested Components
 *
 * Based on: Gossip client architecture (code.png/code1.png)
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { OrchestrationsRouter } from './OrchestrationsRouter';

export abstract class Orchestrator {
  /** Orchestrator name (e.g., "FeedOrchestrator") */
  public readonly name: string;

  /** Reference to the central router */
  protected router: OrchestrationsRouter | null = null;

  constructor(name: string) {
    this.name = name;
  }

  /**
   * Set router reference (called by Router during registration)
   */
  public setRouter(router: OrchestrationsRouter): void {
    this.router = router;
  }

  /**
   * Handle UI-triggered actions (e.g., user clicks "Load More")
   * @param data - Action-specific data from UI
   */
  public abstract onui(data: unknown): void;

  /**
   * Handle relay connection opened
   * @param relay - Relay URL that connected
   */
  public abstract onopen(relay: string): void;

  /**
   * Handle incoming Nostr event
   * @param relay - Relay URL that sent the event
   * @param event - Nostr event
   */
  public abstract onmessage(relay: string, event: NostrEvent): void;

  /**
   * Handle relay error
   * @param relay - Relay URL that errored
   * @param error - Error object
   */
  public abstract onerror(relay: string, error: Error): void;

  /**
   * Handle relay connection closed
   * @param relay - Relay URL that closed
   */
  public abstract onclose(relay: string): void;

  /**
   * Cleanup resources when orchestrator is destroyed
   */
  public destroy(): void {
    this.router = null;
  }
}
