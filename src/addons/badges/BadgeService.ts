/**
 * BadgeService — Create, fetch, and award NIP-58 badges.
 *
 * - Create kind:30009 badge definitions (name, description, image)
 * - Fetch own badge definitions
 * - Award kind:8 to recipient pubkeys
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { AuthService } from '../../services/AuthService';
import { NostrTransport } from '../../services/transport/NostrTransport';
import { ToastService } from '../../services/ToastService';
import { ErrorService } from '../../services/ErrorService';
import { AuthGuard } from '../../services/AuthGuard';
import { diagLog } from '../../services/DiagnosticLogger';

export interface BadgeDefinitionInput {
  slug: string;
  name: string;
  description: string | undefined;
  imageUrl: string | undefined;
  thumbUrl?: string | undefined;
}

export interface OwnBadgeDefinition {
  slug: string;
  name: string;
  description: string;
  imageUrl: string | undefined;
  thumbUrl: string | undefined;
  event: NostrEvent;
}

export class BadgeService {
  private static instance: BadgeService | null = null;
  private authService: AuthService;
  private transport: NostrTransport;
  private ownDefinitions: OwnBadgeDefinition[] = [];

  private constructor() {
    this.authService = AuthService.getInstance();
    this.transport = NostrTransport.getInstance();
  }

  public static getInstance(): BadgeService {
    if (!BadgeService.instance) {
      BadgeService.instance = new BadgeService();
    }
    return BadgeService.instance;
  }

  public destroy(): void {
    this.ownDefinitions = [];
    BadgeService.instance = null;
  }

  public async createBadgeDefinition(input: BadgeDefinitionInput): Promise<boolean> {
    if (!AuthGuard.requireAuth('create badge')) return false;
    const user = this.authService.getCurrentUser();
    if (!user) return false;

    const tags: string[][] = [
      ['d', input.slug],
      ['name', input.name],
    ];
    if (input.description) tags.push(['description', input.description]);
    if (input.imageUrl) tags.push(['image', input.imageUrl]);
    if (input.thumbUrl) tags.push(['thumb', input.thumbUrl]);

    const unsignedEvent = {
      kind: 30009,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: '',
      pubkey: user.pubkey,
    };

    try {
      const signedEvent = await this.authService.signEvent(unsignedEvent);
      if (!signedEvent) {
        ToastService.show('Signing failed', 'error');
        return false;
      }
      await this.transport.publishContent(signedEvent);
      diagLog('system', 'Badge definition created', { slug: input.slug, name: input.name });
      ToastService.show('Badge created', 'success');
      void this.fetchOwnDefinitions();
      return true;
    } catch (error) {
      ErrorService.handle(error, 'BadgeService.createBadgeDefinition', true, 'Failed to create badge');
      return false;
    }
  }

  public async awardBadge(coordinate: string, recipientPubkeys: string[]): Promise<boolean> {
    if (!AuthGuard.requireAuth('award badge')) return false;
    const user = this.authService.getCurrentUser();
    if (!user) return false;

    const tags: string[][] = [
      ['a', coordinate],
    ];
    for (const pk of recipientPubkeys) {
      tags.push(['p', pk]);
    }

    const unsignedEvent = {
      kind: 8,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: '',
      pubkey: user.pubkey,
    };

    try {
      const signedEvent = await this.authService.signEvent(unsignedEvent);
      if (!signedEvent) {
        ToastService.show('Signing failed', 'error');
        return false;
      }
      await this.transport.publishContent(signedEvent);
      diagLog('system', 'Badge awarded', { coordinate, recipients: recipientPubkeys.length });
      ToastService.show('Badge awarded', 'success');
      return true;
    } catch (error) {
      ErrorService.handle(error, 'BadgeService.awardBadge', true, 'Failed to award badge');
      return false;
    }
  }

  /**
   * Accept a badge by adding it to the user's kind:10008 Profile Badges event.
   * Fetches the current kind:10008, appends the new a+e pair, republishes.
   */
  public async acceptBadge(badgeCoordinate: string, awardEventId: string): Promise<boolean> {
    if (!AuthGuard.requireAuth('accept badge')) return false;
    const user = this.authService.getCurrentUser();
    if (!user) return false;

    // Fetch existing kind:10008
    const relays = this.transport.getWriteRelays();
    const existing = await this.transport.fetch(
      relays,
      [{ kinds: [10008 as number], authors: [user.pubkey], limit: 1 }],
      5000, false, 'BadgeSvc'
    );

    // Build tags: existing pairs + new pair
    const tags: string[][] = [];
    if (existing[0]) {
      for (const t of existing[0].tags) {
        tags.push([...t]);
      }
    }
    tags.push(['a', badgeCoordinate]);
    tags.push(['e', awardEventId]);

    const unsignedEvent = {
      kind: 10008,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: '',
      pubkey: user.pubkey,
    };

    try {
      const signedEvent = await this.authService.signEvent(unsignedEvent);
      if (!signedEvent) {
        ToastService.show('Signing failed', 'error');
        return false;
      }
      await this.transport.publishEverywhere(signedEvent);
      diagLog('system', 'Badge accepted', { badgeCoordinate, awardEventId });
      ToastService.show('Badge accepted', 'success');
      return true;
    } catch (error) {
      ErrorService.handle(error, 'BadgeService.acceptBadge', true, 'Failed to accept badge');
      return false;
    }
  }

  /**
   * Fetch all kind:8 awards the current user has issued for a given badge coordinate.
   */
  public async fetchAwardsForBadge(coordinate: string): Promise<NostrEvent[]> {
    const user = this.authService.getCurrentUser();
    if (!user) return [];

    const relays = this.transport.getWriteRelays();
    const events = await this.transport.fetch(
      relays,
      [{ kinds: [8 as number], authors: [user.pubkey], '#a': [coordinate] }],
      5000, false, 'BadgeSvc'
    );
    return events;
  }

  /**
   * Revoke a badge award by deleting the kind:8 event.
   */
  public async revokeAward(awardEventId: string): Promise<boolean> {
    try {
      const { ModuleLoader } = await import('../../core/ModuleLoader');
      const success = await (ModuleLoader.getInstance().getApi<import('../../modules/posts/contracts').PostsModuleApi>('posts')?.deleteEvent(awardEventId) ?? Promise.resolve(false));
      if (success) ToastService.show('Badge revoked', 'success');
      return success;
    } catch (error) {
      ErrorService.handle(error, 'BadgeService.revokeAward', true, 'Failed to revoke badge');
      return false;
    }
  }

  public async fetchOwnDefinitions(): Promise<OwnBadgeDefinition[]> {
    const user = this.authService.getCurrentUser();
    if (!user) return [];

    const relays = this.transport.getWriteRelays();
    const events = await this.transport.fetch(
      relays,
      [{ kinds: [30009 as number], authors: [user.pubkey] }],
      5000,
      false,
      'BadgeSvc'
    );

    const deduped = new Map<string, NostrEvent>();
    for (const ev of events) {
      const dTag = ev.tags.find(t => t[0] === 'd')?.[1] ?? '';
      const existing = deduped.get(dTag);
      if (!existing || (ev.created_at ?? 0) > (existing.created_at ?? 0)) {
        deduped.set(dTag, ev);
      }
    }

    this.ownDefinitions = Array.from(deduped.values()).map(ev => {
      const slug = ev.tags.find(t => t[0] === 'd')?.[1] ?? '';
      const name = ev.tags.find(t => t[0] === 'name')?.[1] ?? slug;
      const description = ev.tags.find(t => t[0] === 'description')?.[1] ?? '';
      const imageUrl = ev.tags.find(t => t[0] === 'image')?.[1] ?? undefined;
      const thumbUrl = ev.tags.find(t => t[0] === 'thumb')?.[1] ?? undefined;
      return { slug, name, description, imageUrl, thumbUrl, event: ev };
    });

    return this.ownDefinitions;
  }

  public getOwnDefinitions(): OwnBadgeDefinition[] {
    return this.ownDefinitions;
  }
}
