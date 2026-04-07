/**
 * EmojiService — Custom Emojis addon
 *
 * Manages the current user's personal NIP-30 emoji pack (kind:30030).
 * Single pack with deterministic d-tag "personal" for v2 (multi-pack later).
 *
 * Authoritative storage: relays via kind:30030 events
 * Cache: PerAccountLocalStorage (offline + fast initial load)
 *
 * Cross-client compat:
 *   The pack uses the standard NIP-30 format ([emoji, code, url]) and is fetched
 *   by other Nostr clients via authors: [pubkey], kinds: [30030] queries.
 *
 * Heavy by design — only loaded via dynamic import when the Custom Emojis addon
 * is enabled. See `index.ts` for the lightweight feature flag.
 */

import { fetchEvents, publishEvent, signEvent, getCurrentUserPubkey } from '../../lists/relays';
import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';
import { EventBus } from '../../services/EventBus';
import { now } from '../../lists/storage';

export interface PersonalEmoji {
  shortcode: string;
  url: string;
}

interface CachedPack {
  emojis: PersonalEmoji[];
  updatedAt: number;
}

const PACK_D_TAG = 'personal';
const PACK_NAME = 'Personal Emojis';
const PACK_ALT = 'Emoji pack';

export class EmojiService {
  private static instance: EmojiService | null = null;

  private storage: PerAccountLocalStorage;
  private eventBus: EventBus;
  private emojis: PersonalEmoji[] = [];

  private constructor() {
    this.storage = PerAccountLocalStorage.getInstance();
    this.eventBus = EventBus.getInstance();
    this.loadFromCache();
  }

  public static getInstance(): EmojiService {
    if (!EmojiService.instance) {
      EmojiService.instance = new EmojiService();
    }
    return EmojiService.instance;
  }

  /** Synchronous read of the in-memory list. */
  public getEmojis(): PersonalEmoji[] {
    return [...this.emojis];
  }

  public findEmoji(shortcode: string): PersonalEmoji | null {
    return this.emojis.find(e => e.shortcode === shortcode) ?? null;
  }

  /**
   * Fetch the personal pack from relays. Replaces local state if the relay
   * version is newer than the cache. Safe to call repeatedly.
   */
  public async refreshFromRelays(): Promise<void> {
    const pubkey = getCurrentUserPubkey();
    if (!pubkey) return;

    try {
      const events = await fetchEvents([{
        kinds: [30030],
        authors: [pubkey],
        '#d': [PACK_D_TAG],
        limit: 1,
      } as any]);

      if (events.length === 0) {
        return;
      }

      // Replaceable event — newest wins
      const event = events.sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0]!;
      const cache = this.readCache();
      if (cache && (event.created_at || 0) <= cache.updatedAt) {
        // Cache is up-to-date or newer (e.g. local pending change)
        return;
      }

      this.emojis = parseEmojiTags(event.tags || []);
      this.persistCache(event.created_at || now());
      this.eventBus.emit('emojis:updated', { emojis: this.emojis });
    } catch (err) {
      console.warn('[EmojiService] refresh failed:', err);
    }
  }

  /** Add a new emoji and republish the pack. */
  public async addEmoji(shortcode: string, url: string): Promise<void> {
    const sanitized = shortcode.trim().replace(/^:|:$/g, '');
    if (!/^[a-zA-Z0-9_-]+$/.test(sanitized)) {
      throw new Error('Shortcode may only contain letters, numbers, underscores, and hyphens');
    }
    if (!/^https?:\/\//.test(url)) {
      throw new Error('URL must start with http:// or https://');
    }
    if (this.emojis.some(e => e.shortcode === sanitized)) {
      throw new Error(`Shortcode ":${sanitized}:" already exists`);
    }

    const next = [...this.emojis, { shortcode: sanitized, url: url.trim() }];
    await this.publishPack(next);
  }

  /** Remove an emoji by shortcode and republish. */
  public async removeEmoji(shortcode: string): Promise<void> {
    const next = this.emojis.filter(e => e.shortcode !== shortcode);
    if (next.length === this.emojis.length) return;
    await this.publishPack(next);
  }

  // ── Internals ────────────────────────────────────────────────────

  private async publishPack(emojis: PersonalEmoji[]): Promise<void> {
    const pubkey = getCurrentUserPubkey();
    if (!pubkey) throw new Error('Not authenticated');

    const created_at = now();
    const event = {
      kind: 30030,
      created_at,
      pubkey,
      content: '',
      tags: [
        ['d', PACK_D_TAG],
        ['name', PACK_NAME],
        ['alt', PACK_ALT],
        ...emojis.map(e => ['emoji', e.shortcode, e.url]),
      ],
    };

    const signed = await signEvent(event);
    if (!signed) throw new Error('Failed to sign emoji pack event');

    await publishEvent(signed);

    this.emojis = emojis;
    this.persistCache(created_at);
    this.eventBus.emit('emojis:updated', { emojis: this.emojis });
  }

  private loadFromCache(): void {
    const cache = this.readCache();
    if (cache) {
      this.emojis = cache.emojis;
    }
  }

  private readCache(): CachedPack | null {
    return this.storage.get<CachedPack | null>(StorageKeys.PERSONAL_EMOJI_PACK, null);
  }

  private persistCache(updatedAt: number): void {
    this.storage.set(StorageKeys.PERSONAL_EMOJI_PACK, { emojis: this.emojis, updatedAt });
  }
}

/** Pure helper: extract NIP-30 emoji tags from a tag array. */
function parseEmojiTags(tags: string[][]): PersonalEmoji[] {
  return tags
    .filter(t => t[0] === 'emoji' && t.length >= 3 && t[1] && t[2])
    .map(t => ({ shortcode: t[1]!, url: t[2]! }));
}
