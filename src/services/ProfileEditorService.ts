/**
 * ProfileEditorService - Profile Metadata Publishing Service
 * Handles creation and publishing of Kind 0 (profile metadata) events
 *
 * Kind 0: Profile metadata (replaceable event)
 * NIP-01: https://github.com/nostr-protocol/nips/blob/master/01.md
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { AuthService } from './AuthService';
import { NostrTransport } from './transport/NostrTransport';
import { SystemLogger } from './SystemLogger';
import { ErrorService } from './ErrorService';
import { ToastService } from './ToastService';
import { RelayConfig } from './RelayConfig';

/**
 * Profile metadata fields (NIP-01)
 */
export interface ProfileMetadata {
  /** Username/handle */
  name?: string;
  /** Display name (full name) */
  display_name?: string;
  /** Biography/about text */
  about?: string;
  /** Avatar image URL */
  picture?: string;
  /** Banner image URL */
  banner?: string;
  /** Personal website URL */
  website?: string;
  /** NIP-05 identifier (user@domain.com) - primary/legacy */
  nip05?: string;
  /** Multiple NIP-05 identifiers (Animestr-style, stored as tags) */
  nip05s?: string[];
  /** Lightning address (email format) */
  lud16?: string;
  /** LNURL address (fallback) */
  lud06?: string;
}

export class ProfileEditorService {
  private static instance: ProfileEditorService;
  private authService: AuthService;
  private transport: NostrTransport;
  private systemLogger: SystemLogger;
  private relayConfig: RelayConfig;

  private constructor() {
    this.authService = AuthService.getInstance();
    this.transport = NostrTransport.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.relayConfig = RelayConfig.getInstance();
  }

  public static getInstance(): ProfileEditorService {
    if (!ProfileEditorService.instance) {
      ProfileEditorService.instance = new ProfileEditorService();
    }
    return ProfileEditorService.instance;
  }

  /**
   * Update user profile metadata (Kind 0 event)
   *
   * @param metadata - Profile fields to update
   * @returns Promise<NostrEvent | null> - Published event on success, null on failure
   */
  public async updateProfile(
    metadata: ProfileMetadata
  ): Promise<NostrEvent | null> {
    // Validate authentication
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.systemLogger.error(
        'ProfileEditorService',
        'Cannot update profile: User not authenticated'
      );
      return null;
    }

    // Validate metadata fields
    const validationError = this.validateMetadata(metadata);
    if (validationError) {
      this.systemLogger.error(
        'ProfileEditorService',
        `Validation failed: ${validationError}`
      );
      ToastService.show(validationError, 'error');
      return null;
    }

    // Get write relays
    const writeRelays = this.relayConfig.getWriteRelays();
    if (!writeRelays || writeRelays.length === 0) {
      this.systemLogger.error(
        'ProfileEditorService',
        'Cannot update profile: No write relays configured'
      );
      ToastService.show(
        'No write relays configured. Please check your settings.',
        'error'
      );
      return null;
    }

    try {
      // Handle multiple NIP-05 addresses (Animestr-style)
      // Store primary in content.nip05, all as tags for compatibility
      const nip05s =
        metadata.nip05s && metadata.nip05s.length > 0
          ? metadata.nip05s
          : metadata.nip05
            ? [metadata.nip05]
            : [];

      // Clean metadata (remove undefined/null fields)
      // Remove nip05s from content (only goes in tags)
      const metadataWithoutNip05s = { ...metadata } as Partial<typeof metadata>;
      delete metadataWithoutNip05s.nip05s;
      const cleanedMetadata = this.cleanMetadata(metadataWithoutNip05s);

      // Set primary NIP-05 in content (for compatibility with other clients)
      const primaryNip05 = nip05s[0];
      if (primaryNip05) {
        cleanedMetadata.nip05 = primaryNip05;
      }

      // Build tags - duplicate all profile fields as tags (Animestr-style)
      const tags: string[][] = [];

      // Add all profile fields as tags (like Animestr does)
      if (cleanedMetadata.displayName)
        tags.push(['displayName', cleanedMetadata.displayName]);
      if (cleanedMetadata.display_name)
        tags.push(['display_name', cleanedMetadata.display_name]);
      if (cleanedMetadata.name) tags.push(['name', cleanedMetadata.name]);
      if (cleanedMetadata.about) tags.push(['about', cleanedMetadata.about]);
      if (cleanedMetadata.picture)
        tags.push(['picture', cleanedMetadata.picture]);
      if (cleanedMetadata.banner) tags.push(['banner', cleanedMetadata.banner]);

      // Add all NIP-05 addresses as tags
      nip05s.forEach(nip05 => {
        tags.push(['nip05', nip05]);
      });

      // Add lightning address as tag
      if (cleanedMetadata.lud16) tags.push(['lud16', cleanedMetadata.lud16]);
      if (cleanedMetadata.lud06) tags.push(['lud06', cleanedMetadata.lud06]);

      // Build Kind 0 event
      const unsignedEvent = {
        kind: 0,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: JSON.stringify(cleanedMetadata),
        pubkey: currentUser.pubkey,
      };

      // Sign event
      const signedEvent = await this.authService.signEvent(unsignedEvent);

      if (!signedEvent) {
        this.systemLogger.error(
          'ProfileEditorService',
          'Failed to sign profile event'
        );
        return null;
      }

      // Treat kind:0 (Profile) as a DISCOVERY event, alongside kind:10002
      // and kind:10050: it goes to the user's own write-relays PLUS the
      // aggregator + indexer set (purplepag.es / hzrd149 / coracle /
      // kindpag.es) via `publishEverywhere`. Profiles are public and
      // their broad presence on the well-known indexer relays is what
      // lets every Nostr client — even those without strict NIP-65
      // outbound resolution — render the user's name and avatar without
      // forcing the casual user to manage a separate "Discovery" relay
      // type in Settings. Same approach Jumble uses with its hardcoded
      // `BIG_RELAY_URLS` discovery layer (see Jumble's
      // `src/services/client.service.ts`).
      //
      // The Private-Relay-Sovereignty story is not broken by this:
      // profiles are public-by-design, no encrypted-content leak. A user
      // who wants true profile-privacy needs more than relay choice
      // anyway — they need a separate npub.
      await this.transport.publishEverywhere(signedEvent);

      this.systemLogger.info(
        'ProfileEditorService',
        `Profile updated and broadcast across discovery relays: ${signedEvent.id?.slice(0, 8)}...`
      );

      // Show success toast
      ToastService.show('Profile updated successfully!', 'success');

      return signedEvent;
    } catch (error) {
      // Centralized error handling with user notification
      ErrorService.handle(
        error,
        'ProfileEditorService.updateProfile',
        true,
        'Failed to update profile. Please try again.'
      );
      return null;
    }
  }

  /**
   * Validate profile metadata fields
   *
   * @param metadata - Profile fields to validate
   * @returns Error message or null if valid
   */
  private validateMetadata(metadata: ProfileMetadata): string | null {
    // Validate single NIP-05 (legacy)
    if (metadata.nip05 && !this.validateNip05(metadata.nip05)) {
      return 'Invalid NIP-05 format. Use: user@domain.com';
    }

    // Validate multiple NIP-05s
    if (metadata.nip05s && metadata.nip05s.length > 0) {
      for (const nip05 of metadata.nip05s) {
        if (!this.validateNip05(nip05)) {
          return `Invalid NIP-05 format: ${nip05}. Use: user@domain.com`;
        }
      }
    }

    // Validate Lightning address
    if (
      metadata.lud16 &&
      !this.validateLightningAddress(metadata.lud16).valid
    ) {
      return 'Invalid Lightning address. Use email format or LNURL.';
    }

    if (
      metadata.lud06 &&
      !this.validateLightningAddress(metadata.lud06).valid
    ) {
      return 'Invalid LNURL format.';
    }

    // Validate website URL
    if (metadata.website && !this.validateUrl(metadata.website)) {
      return 'Invalid website URL. Use format: https://example.com';
    }

    // Validate picture URL
    if (metadata.picture && !this.validateUrl(metadata.picture)) {
      return 'Invalid avatar image URL.';
    }

    // Validate banner URL
    if (metadata.banner && !this.validateUrl(metadata.banner)) {
      return 'Invalid banner image URL.';
    }

    return null;
  }

  /**
   * Validate NIP-05 identifier format
   *
   * @param nip05 - NIP-05 identifier (user@domain.com)
   * @returns true if valid
   */
  public validateNip05(nip05: string): boolean {
    // Format: user@domain.com or _@domain.com
    return /^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(nip05);
  }

  /**
   * Validate Lightning address format
   *
   * @param address - Lightning address (email format or LNURL)
   * @returns { valid: boolean; field: 'lud16' | 'lud06' }
   */
  public validateLightningAddress(address: string): {
    valid: boolean;
    field: 'lud16' | 'lud06';
  } {
    // Email format (lud16)
    if (/^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(address)) {
      return { valid: true, field: 'lud16' };
    }

    // LNURL format (lud06)
    if (address.toLowerCase().startsWith('lnurl')) {
      return { valid: true, field: 'lud06' };
    }

    return { valid: false, field: 'lud16' };
  }

  /**
   * Validate URL format
   *
   * @param url - URL to validate
   * @returns true if valid
   */
  private validateUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /**
   * Clean metadata object (remove undefined/null/empty fields)
   *
   * @param metadata - Raw metadata
   * @returns Cleaned metadata
   */
  private cleanMetadata(metadata: ProfileMetadata): Record<string, string> {
    const cleaned: Record<string, string> = {};

    Object.entries(metadata).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        cleaned[key] = typeof value === 'string' ? value : String(value);
      }
    });

    return cleaned;
  }
}
