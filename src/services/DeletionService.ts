/**
 * DeletionService - NIP-09 Event Deletion Implementation
 * Handles creation and publishing of Kind 5 deletion request events
 *
 * NIP-09: https://github.com/nostr-protocol/nips/blob/master/09.md
 *
 * Deletion Strategy:
 * - TEST Mode (Local Relay): Deletes only from ws://localhost:7777
 * - PROXY Mode / No Local Relay: Deletes from ALL relays in settings (read + write)
 *
 * Important: Deletion is NOT guaranteed. Relays may choose to ignore deletion requests.
 */

import { AuthService } from './AuthService';
import { AuthGuard } from './AuthGuard';
import { NostrTransport } from './transport/NostrTransport';
import { RelayConfig } from './RelayConfig';
import { SystemLogger } from '../components/system/SystemLogger';
import { ErrorService } from './ErrorService';
import { ToastService } from './ToastService';

export interface DeletionOptions {
  /** Event ID(s) to delete (regular events) */
  eventIds?: string[];
  /** Coordinate(s) to delete (parameterized replaceable events) */
  coordinates?: string[];
  /** Optional: Reason for deletion (shown in content field) */
  reason?: string;
}

export class DeletionService {
  private static instance: DeletionService;
  private authService: AuthService;
  private transport: NostrTransport;
  private relayConfig: RelayConfig;
  private systemLogger: SystemLogger;

  private constructor() {
    this.authService = AuthService.getInstance();
    this.transport = NostrTransport.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): DeletionService {
    if (!DeletionService.instance) {
      DeletionService.instance = new DeletionService();
    }
    return DeletionService.instance;
  }

  /**
   * Create and publish a deletion request event (Kind 5)
   *
   * Strategy:
   * - If local relay is active (TEST mode): Send ONLY to local relay
   * - Otherwise: Send to ALL relays in settings (ignoring read/write designation)
   *
   * @param options - Deletion configuration
   * @returns Promise<boolean> - Success status
   */
  public async deleteEvents(options: DeletionOptions): Promise<boolean> {
    // Check authentication for deletion (Write Event)
    if (!AuthGuard.requireAuth('delete this note')) {
      return false;
    }

    const { eventIds, coordinates, reason } = options;

    // Validate authentication (redundant check for safety, but AuthGuard already handled UI)
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.systemLogger.error('DeletionService', 'Cannot delete events: User not authenticated');
      return false;
    }

    // Validate that at least one deletion target is provided
    if ((!eventIds || eventIds.length === 0) && (!coordinates || coordinates.length === 0)) {
      this.systemLogger.error('DeletionService', 'No event IDs or coordinates provided for deletion');
      return false;
    }

    try {
      // Build tags according to NIP-09
      const tags: string[][] = [];

      // Add e tag for each regular event to delete
      if (eventIds && eventIds.length > 0) {
        eventIds.forEach(eventId => {
          tags.push(['e', eventId]);
        });
      }

      // Add a tag for each parameterized replaceable event to delete
      if (coordinates && coordinates.length > 0) {
        coordinates.forEach(coordinate => {
          tags.push(['a', coordinate]);
        });
      }

      // Build unsigned event
      const unsignedEvent = {
        kind: 5,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: reason || '',
        pubkey: currentUser.pubkey
      };

      // Sign event using browser extension
      const signedEvent = await this.authService.signEvent(unsignedEvent);

      if (!signedEvent) {
        this.systemLogger.error('DeletionService', 'Failed to sign deletion event');
        return false;
      }

      // Determine target relays based on local relay status
      const targetRelays = this.getTargetRelays();

      if (targetRelays.length === 0) {
        this.systemLogger.error('DeletionService', 'No relays available for deletion');
        return false;
      }

      // Publish deletion request
      await this.transport.publish(targetRelays, signedEvent);

      const totalItems = (eventIds?.length || 0) + (coordinates?.length || 0);
      this.systemLogger.info(
        'DeletionService',
        `Deletion request published for ${totalItems} item(s) to ${targetRelays.length} relay(s)`
      );

      // Show success toast to user
      ToastService.show('Deletion request sent successfully', 'success');

      return true;
    } catch (error) {
      // Centralized error handling with user notification
      ErrorService.handle(
        error,
        'DeletionService.deleteEvents',
        true,
        'Failed to delete note. Please try again.'
      );
      return false;
    }
  }

  /**
   * Determine which relays to send deletion request to
   *
   * Logic:
   * - Local relay active (TEST mode): ONLY local relay
   * - Otherwise: ALL relays from settings (read + write)
   */
  private getTargetRelays(): string[] {
    // Load local relay settings from localStorage
    const localRelaySettings = this.loadLocalRelaySettings();

    // Check if local relay is active (TEST mode)
    if (localRelaySettings.enabled) {
      this.systemLogger.info(
        'DeletionService',
        `Using local relay in TEST mode: ${localRelaySettings.url}`
      );
      return [localRelaySettings.url];
    }

    // Otherwise, use ALL relays from RelayConfig (ignoring read/write designation)
    const allRelays = this.relayConfig.getAllRelays()
      .filter(r => r.isActive)
      .map(r => r.url);

    this.systemLogger.info(
      'DeletionService',
      `Using all ${allRelays.length} relay(s) from settings for deletion`
    );

    return allRelays;
  }

  /**
   * Load local relay settings from localStorage
   */
  private loadLocalRelaySettings(): { enabled: boolean; url: string; mode: string } {
    try {
      const stored = localStorage.getItem('noornote_local_relay');
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (_error) {
      console.warn('Failed to load local relay settings:', _error);
    }

    return {
      enabled: false,
      mode: 'test',
      url: 'ws://localhost:7777'
    };
  }

  /**
   * Delete a single event (convenience method)
   */
  public async deleteEvent(eventId: string, reason?: string): Promise<boolean> {
    return this.deleteEvents({
      eventIds: [eventId],
      reason
    });
  }

  /**
   * Delete parameterized replaceable events by coordinates (convenience method)
   * @param coordinates - Array of coordinates in format "kind:pubkey:d-tag"
   */
  public async deleteByCoordinates(coordinates: string[], reason?: string): Promise<boolean> {
    return this.deleteEvents({
      coordinates,
      reason
    });
  }
}
