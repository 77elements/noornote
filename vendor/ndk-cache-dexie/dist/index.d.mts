import { NDKUserProfile, NDKRelayInformation, NDKEventId, NDKRawEvent, NDKCacheAdapter, NDKSubscription, NDKEvent, Hexpubkey, ProfilePointer, NDKLnUrlData, NDKFilter, NDKRelay, NDKCacheRelayInfo, CacheModuleDefinition, CacheModuleCollection } from '@nostr-dev-kit/ndk';
import Dexie, { Table } from 'dexie';
import { LRUCache } from 'typescript-lru-cache';

interface Profile extends NDKUserProfile {
    pubkey: string;
    cachedAt: number;
}
interface Event {
    id: string;
    pubkey: string;
    kind: number;
    createdAt: number;
    relay?: string;
    event: string;
    sig?: string;
}
interface EventTag {
    eventId: string;
    tagValue: string;
}
interface Nip05 {
    nip05: string;
    profile: string | null;
    fetchedAt: number;
}
interface Lnurl {
    pubkey: string;
    document: string | null;
    fetchedAt: number;
}
interface RelayStatus {
    url: string;
    updatedAt: number;
    lastConnectedAt?: number;
    dontConnectBefore?: number;
    consecutiveFailures?: number;
    lastFailureAt?: number;
    nip11?: {
        data: NDKRelayInformation;
        fetchedAt: number;
    };
    metadata?: Record<string, Record<string, unknown>>;
}
interface UnpublishedEvent {
    id: NDKEventId;
    event: NDKRawEvent;
    relays: Record<WebSocket["url"], boolean>;
    lastTryAt?: number;
}
interface EventRelay {
    eventId: string;
    relayUrl: string;
    seenAt: number;
}
interface DecryptedEvent {
    id: NDKEventId;
    event: string;
}
declare class Database extends Dexie {
    profiles: Table<Profile>;
    events: Table<Event>;
    eventTags: Table<EventTag>;
    nip05: Table<Nip05>;
    lnurl: Table<Lnurl>;
    relayStatus: Table<RelayStatus>;
    unpublishedEvents: Table<UnpublishedEvent>;
    eventRelays: Table<EventRelay>;
    decryptedEvents: Table<DecryptedEvent>;
    constructor(name: string);
}
declare let db: Database;

interface CacheOptions<T> {
    maxSize: number;
    dump: (dirtyKeys: Set<string>, cache: LRUCache<string, T>) => Promise<void>;
    debug: debug.IDebugger;
}
declare class CacheHandler<T> {
    private cache?;
    private dirtyKeys;
    private options;
    private debug;
    indexes: Map<string | number, LRUCache<string | number, Set<string>>>;
    isSet: boolean;
    maxSize: number;
    constructor(options: CacheOptions<T>);
    getSet(key: string): Set<T> | null;
    /**
     * Get all entries that match the filter.
     */
    getAllWithFilter(filter: (key: string, val: T) => boolean): Map<string, T>;
    get(key: string): T | null | undefined;
    getWithFallback(key: string, table: Table): Promise<T | null | undefined>;
    getManyWithFallback(keys: string[], table: Table): Promise<T[]>;
    add<K>(key: string, value: K, dirty?: boolean): void;
    set(key: string, value: T, dirty?: boolean): void;
    size(): number;
    delete(key: string): void;
    private dump;
    addIndex<_T>(attribute: string | number): void;
    getFromIndex(index: string, key: string | number): Set<T>;
}

type EventTagCacheEntry = string;

type EventCacheEntry = Event;

type Nip05CacheEntry = {
    profile: string | null;
    fetchedAt: number;
};

type ZapperCacheEntry = {
    document: string | null;
    fetchedAt: number;
};

interface NDKCacheAdapterDexieOptions {
    /**
     * The name of the database to use
     */
    dbName?: string;
    /**
     * Debug instance to use for logging
     */
    debug?: debug.IDebugger;
    /**
     * Number of profiles to keep in an LRU cache
     */
    profileCacheSize?: number;
    zapperCacheSize?: number;
    nip05CacheSize?: number;
    eventCacheSize?: number;
    eventTagsCacheSize?: number;
    /**
     * Whether to store event signatures in the cache
     * @default false
     */
    saveSig?: boolean;
}
declare class NDKCacheAdapterDexie implements NDKCacheAdapter {
    debug: debug.Debugger;
    locking: boolean;
    ready: boolean;
    profiles: CacheHandler<Profile>;
    zappers: CacheHandler<ZapperCacheEntry>;
    nip05s: CacheHandler<Nip05CacheEntry>;
    events: CacheHandler<EventCacheEntry>;
    eventTags: CacheHandler<EventTagCacheEntry>;
    relayInfo: CacheHandler<RelayStatus>;
    unpublishedEvents: CacheHandler<UnpublishedEvent>;
    private warmedUp;
    private warmUpPromise;
    devMode: boolean;
    private saveSig;
    _onReady?: () => void;
    private moduleManager;
    constructor(opts?: NDKCacheAdapterDexieOptions);
    onReady(callback: () => void): void;
    query(subscription: NDKSubscription): Promise<NDKEvent[]>;
    fetchProfile(pubkey: Hexpubkey): Promise<NDKUserProfile | null>;
    fetchProfileSync(pubkey: Hexpubkey): NDKUserProfile | null;
    getProfiles(filter: ((pubkey: Hexpubkey, profile: NDKUserProfile) => boolean) | {
        field?: string;
        fields?: string[];
        contains: string;
    }): Promise<Map<Hexpubkey, NDKUserProfile> | undefined>;
    saveProfile(pubkey: Hexpubkey, profile: NDKUserProfile): void;
    loadNip05(nip05: string, maxAgeForMissing?: number): Promise<ProfilePointer | null | "missing">;
    saveNip05(nip05: string, profile: ProfilePointer | null): Promise<void>;
    loadUsersLNURLDoc?(pubkey: Hexpubkey, maxAgeInSecs?: number, maxAgeForMissing?: number): Promise<NDKLnUrlData | null | "missing">;
    saveUsersLNURLDoc(pubkey: Hexpubkey, doc: NDKLnUrlData | null): Promise<void>;
    private processFilter;
    deleteEventIds(eventIds: NDKEventId[]): Promise<void>;
    addUnpublishedEvent: (event: NDKEvent, relays: string[]) => void;
    getUnpublishedEvents: () => Promise<{
        event: NDKEvent;
        relays: WebSocket["url"][];
        lastTryAt?: number;
    }[]>;
    discardUnpublishedEvent: (id: string) => Promise<void>;
    setEvent(event: NDKEvent, _filters: NDKFilter[], relay?: NDKRelay): Promise<void>;
    setEventDup(event: NDKEvent, relay: NDKRelay): void;
    updateRelayStatus(url: string, info: NDKCacheRelayInfo): void;
    getRelayStatus(url: string): NDKCacheRelayInfo | undefined;
    /**
     * Searches by authors
     */
    private byAuthors;
    /**
     * Searches by ids
     */
    private byIdsQuery;
    /**
     * Searches by NIP-33
     */
    private byNip33Query;
    /**
     * Searches by tags and optionally filters by tags
     */
    private byTags;
    private byKinds;
    /**
     * Register a cache module with its schema and migrations
     */
    registerModule(module: CacheModuleDefinition): Promise<void>;
    /**
     * Get a collection from a registered module
     */
    getModuleCollection<T>(namespace: string, collection: string): Promise<CacheModuleCollection<T>>;
    /**
     * Get a decrypted event from the cache by its wrapper ID
     */
    getDecryptedEvent(wrapperId: NDKEventId): Promise<NDKEvent | null>;
    /**
     * Add a decrypted event to the cache
     */
    addDecryptedEvent(wrapperId: NDKEventId, decryptedEvent: NDKEvent): Promise<void>;
}
declare function foundEvents(subscription: NDKSubscription, events: Event[], filter?: NDKFilter): void;
declare function foundEvent(subscription: NDKSubscription, event: Event, relayUrl: WebSocket["url"] | undefined, filter?: NDKFilter): void;

export { type NDKCacheAdapterDexieOptions, db, NDKCacheAdapterDexie as default, foundEvent, foundEvents };
