"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  db: () => db,
  default: () => NDKCacheAdapterDexie,
  foundEvent: () => foundEvent,
  foundEvents: () => foundEvents
});
module.exports = __toCommonJS(index_exports);
var import_ndk2 = require("@nostr-dev-kit/ndk");
var import_debug3 = __toESM(require("debug"));
var import_nostr_tools = require("nostr-tools");

// src/cache-module.ts
var import_debug = __toESM(require("debug"));
var import_dexie = __toESM(require("dexie"));
var debug = (0, import_debug.default)("ndk:dexie-adapter:modules");
var DexieModuleCollection = class {
  constructor(db2, tableName) {
    this.db = db2;
    this.tableName = tableName;
  }
  get table() {
    return this.db[this.tableName];
  }
  async get(id) {
    const result = await this.table.get(id);
    return result || null;
  }
  async getMany(ids) {
    const results = await this.table.where(":id").anyOf(ids).toArray();
    return results;
  }
  async save(item) {
    await this.table.put(item);
  }
  async saveMany(items) {
    await this.table.bulkPut(items);
  }
  async delete(id) {
    await this.table.delete(id);
  }
  async deleteMany(ids) {
    await this.table.where(":id").anyOf(ids).delete();
  }
  async findBy(field, value) {
    return await this.table.where(field).equals(value).toArray();
  }
  async where(conditions) {
    let collection = this.table.toCollection();
    for (const [field, value] of Object.entries(conditions)) {
      collection = collection.and((item) => item[field] === value);
    }
    return await collection.toArray();
  }
  async all() {
    return await this.table.toArray();
  }
  async count(conditions) {
    if (!conditions) {
      return await this.table.count();
    }
    let collection = this.table.toCollection();
    for (const [field, value] of Object.entries(conditions)) {
      collection = collection.and((item) => item[field] === value);
    }
    return await collection.count();
  }
  async clear() {
    await this.table.clear();
  }
};
var DexieCacheModuleManager = class {
  constructor(dbName) {
    this.dbName = dbName;
    this.moduleDb = new import_dexie.default(`${dbName}_modules`);
    this.setupDatabase();
  }
  modules = /* @__PURE__ */ new Map();
  moduleDb;
  initialized = false;
  setupDatabase() {
    this.moduleDb.version(1).stores({
      moduleMetadata: "&namespace"
    });
  }
  /**
   * Register a cache module
   */
  async registerModule(module2) {
    if (!this.moduleDb.isOpen()) {
      await this.moduleDb.open();
    }
    const metadataTable = this.moduleDb.table("moduleMetadata");
    const existingMetadata = await metadataTable.get(module2.namespace);
    const currentVersion = existingMetadata?.version || 0;
    if (currentVersion >= module2.version) {
      debug(`Module ${module2.namespace} is already at version ${currentVersion}`);
      return;
    }
    const currentDbVersion = this.moduleDb.verno;
    const newDbVersion = currentDbVersion + 1;
    this.moduleDb.close();
    const stores = {
      moduleMetadata: "&namespace"
    };
    for (const [collName, collDef] of Object.entries(module2.collections)) {
      const tableName = `${module2.namespace}_${collName}`;
      let indexString = `&${collDef.primaryKey}`;
      if (collDef.indexes) {
        indexString += `, ${collDef.indexes.join(", ")}`;
      }
      if (collDef.compoundIndexes) {
        const compounds = collDef.compoundIndexes.map((fields) => `[${fields.join("+")}]`);
        indexString += `, ${compounds.join(", ")}`;
      }
      stores[tableName] = indexString;
    }
    this.moduleDb.version(newDbVersion).stores(stores);
    await this.moduleDb.open();
    for (let version = currentVersion + 1; version <= module2.version; version++) {
      if (module2.migrations[version]) {
        debug(`Running migration ${version} for module ${module2.namespace}`);
        const context = {
          fromVersion: currentVersion,
          toVersion: version,
          async getCollection(name) {
            return new DexieModuleCollection(this.moduleDb, `${module2.namespace}_${name}`);
          },
          async createCollection(name, definition) {
            debug(`Collection ${name} created during schema update`);
          },
          async deleteCollection(name) {
            debug(`Collection deletion requires database recreation`);
          },
          async addIndex(collection, field) {
            debug(`Index addition requires database recreation`);
          }
        };
        await module2.migrations[version](context);
      }
    }
    await metadataTable.put({
      namespace: module2.namespace,
      version: module2.version,
      lastMigration: Date.now(),
      collections: Object.keys(module2.collections)
    });
    this.modules.set(module2.namespace, module2);
    debug(`Module ${module2.namespace} registered at version ${module2.version}`);
  }
  /**
   * Get a collection from a module
   */
  async getModuleCollection(namespace, collection) {
    if (!this.moduleDb.isOpen()) {
      await this.moduleDb.open();
    }
    const tableName = `${namespace}_${collection}`;
    const table = this.moduleDb[tableName];
    if (!table) {
      const metadata = await this.moduleDb.table("moduleMetadata").get(namespace);
      if (!metadata) {
        throw new Error(`Module ${namespace} not registered`);
      }
      throw new Error(`Collection ${collection} not found in module ${namespace}`);
    }
    return new DexieModuleCollection(this.moduleDb, tableName);
  }
  /**
   * Check if a module is registered
   */
  hasModule(namespace) {
    return this.modules.has(namespace);
  }
  /**
   * Get the current version of a module
   */
  async getModuleVersion(namespace) {
    if (!this.moduleDb.isOpen()) {
      await this.moduleDb.open();
    }
    const metadata = await this.moduleDb.table("moduleMetadata").get(namespace);
    return metadata?.version || 0;
  }
};

// src/caches/event-tags.ts
async function eventTagsWarmUp(cacheHandler, eventTags) {
  const array = await eventTags.limit(cacheHandler.maxSize).toArray();
  for (const event of array) {
    cacheHandler.add(event.tagValue, event.eventId, false);
  }
}
var eventTagsDump = (eventTags, debug2) => {
  return async (dirtyKeys, cache) => {
    const entries = [];
    for (const tagValue of dirtyKeys) {
      const eventIds = cache.get(tagValue);
      if (eventIds) {
        for (const eventId of eventIds) entries.push({ tagValue, eventId });
      }
    }
    if (entries.length > 0) {
      debug2(`Saving ${entries.length} events cache entries to database`);
      await eventTags.bulkPut(entries);
    }
    dirtyKeys.clear();
  };
};

// src/caches/events.ts
async function eventsWarmUp(cacheHandler, events) {
  const array = await events.limit(cacheHandler.maxSize).toArray();
  for (const event of array) {
    cacheHandler.set(event.id, event, false);
  }
}
var eventsDump = (events, debug2) => {
  return async (dirtyKeys, cache) => {
    const entries = [];
    for (const event of dirtyKeys) {
      const entry = cache.get(event);
      if (entry) entries.push(entry);
    }
    if (entries.length > 0) {
      debug2(`Saving ${entries.length} events cache entries to database`);
      await events.bulkPut(entries);
    }
    dirtyKeys.clear();
  };
};

// src/caches/nip05.ts
async function nip05WarmUp(cacheHandler, nip05s) {
  const array = await nip05s.limit(cacheHandler.maxSize).toArray();
  for (const nip05 of array) {
    cacheHandler.set(nip05.nip05, nip05, false);
  }
}
var nip05Dump = (nip05s, debug2) => {
  return async (dirtyKeys, cache) => {
    const entries = [];
    for (const nip05 of dirtyKeys) {
      const entry = cache.get(nip05);
      if (entry) {
        entries.push({
          nip05,
          ...entry
        });
      }
    }
    if (entries.length) {
      debug2(`Saving ${entries.length} NIP-05 cache entries to database`);
      await nip05s.bulkPut(entries);
    }
    dirtyKeys.clear();
  };
};

// src/db.ts
var import_dexie2 = __toESM(require("dexie"));
var Database = class extends import_dexie2.default {
  profiles;
  events;
  eventTags;
  nip05;
  lnurl;
  relayStatus;
  unpublishedEvents;
  eventRelays;
  decryptedEvents;
  constructor(name) {
    super(name);
    this.version(19).stores({
      profiles: "&pubkey",
      events: "&id, kind",
      eventTags: "[tagValue+eventId], tagValue",
      nip05: "&nip05",
      lnurl: "&pubkey",
      relayStatus: "&url",
      unpublishedEvents: "&id",
      eventRelays: "[eventId+relayUrl], eventId",
      decryptedEvents: "&id"
    });
  }
};
var db;
function createDatabase(name) {
  db = new Database(name);
}

// src/caches/profiles.ts
var import_debug2 = __toESM(require("debug"));
var d = (0, import_debug2.default)("ndk:dexie-adapter:profiles");
async function profilesWarmUp(cacheHandler, profiles) {
  const array = await profiles.limit(cacheHandler.maxSize).toArray();
  for (const user of array) {
    const obj = user;
    cacheHandler.set(user.pubkey, obj, false);
  }
  d("Loaded %d profiles from database", cacheHandler.size());
}
var profilesDump = (profiles, debug2) => {
  return async (dirtyKeys, cache) => {
    const entries = [];
    for (const pubkey of dirtyKeys) {
      const entry = cache.get(pubkey);
      if (entry) {
        entries.push(entry);
      }
    }
    if (entries.length) {
      debug2(`Saving ${entries.length} users to database`);
      await profiles.bulkPut(entries);
    }
    dirtyKeys.clear();
  };
};

// src/caches/relay-info.ts
async function relayInfoWarmUp(cacheHandler, relayStatus) {
  const array = await relayStatus.limit(cacheHandler.maxSize).toArray();
  for (const entry of array) {
    cacheHandler.set(
      entry.url,
      {
        url: entry.url,
        updatedAt: entry.updatedAt,
        lastConnectedAt: entry.lastConnectedAt,
        dontConnectBefore: entry.dontConnectBefore
      },
      false
    );
  }
}
var relayInfoDump = (relayStatus, debug2) => {
  return async (dirtyKeys, cache) => {
    const entries = [];
    for (const url of dirtyKeys) {
      const info = cache.get(url);
      if (info) {
        entries.push({
          url,
          updatedAt: info.updatedAt,
          lastConnectedAt: info.lastConnectedAt,
          dontConnectBefore: info.dontConnectBefore
        });
      }
    }
    if (entries.length > 0) {
      debug2(`Saving ${entries.length} relay status cache entries to database`);
      await relayStatus.bulkPut(entries);
    }
    dirtyKeys.clear();
  };
};

// src/caches/unpublished-events.ts
var import_ndk = require("@nostr-dev-kit/ndk");
var WRITE_STATUS_THRESHOLD = 3;
async function unpublishedEventsWarmUp(cacheHandler, unpublishedEvents) {
  await unpublishedEvents.each((unpublishedEvent) => {
    cacheHandler.set(unpublishedEvent.event.id, unpublishedEvent, false);
  });
}
function unpublishedEventsDump(unpublishedEvents, debug2) {
  return async (dirtyKeys, cache) => {
    const entries = [];
    for (const eventId of dirtyKeys) {
      const entry = cache.get(eventId);
      if (entry) {
        entries.push(entry);
      }
    }
    if (entries.length > 0) {
      debug2(`Saving ${entries.length} unpublished events cache entries to database`);
      await unpublishedEvents.bulkPut(entries);
    }
    dirtyKeys.clear();
  };
}
async function discardUnpublishedEvent(unpublishedEvents, eventId) {
  await unpublishedEvents.delete(eventId);
}
async function getUnpublishedEvents(unpublishedEvents) {
  const events = [];
  await unpublishedEvents.each((unpublishedEvent) => {
    events.push({
      event: new import_ndk.NDKEvent(void 0, unpublishedEvent.event),
      relays: Object.keys(unpublishedEvent.relays),
      lastTryAt: unpublishedEvent.lastTryAt
    });
  });
  return events;
}
function addUnpublishedEvent(event, relays) {
  const r = {};
  relays.forEach((url) => r[url] = false);
  this.unpublishedEvents.set(event.id, { id: event.id, event: event.rawEvent(), relays: r });
  this.setEvent(event, [], void 0).catch((e) => {
    console.error("[addUnpublishedEvent] Failed to store event in main table:", e);
  });
  const onPublished = (relay) => {
    const url = relay.url;
    const existingEntry = this.unpublishedEvents.get(event.id);
    if (!existingEntry) {
      event.off("publushed", onPublished);
      return;
    }
    existingEntry.relays[url] = true;
    this.unpublishedEvents.set(event.id, existingEntry);
    const successWrites = Object.values(existingEntry.relays).filter((v) => v).length;
    const unsuccessWrites = Object.values(existingEntry.relays).length - successWrites;
    if (successWrites >= WRITE_STATUS_THRESHOLD || unsuccessWrites === 0) {
      this.unpublishedEvents.delete(event.id);
      event.off("published", onPublished);
    }
  };
  event.on("published", onPublished);
}

// src/caches/zapper.ts
async function zapperWarmUp(cacheHandler, lnurls) {
  const array = await lnurls.limit(cacheHandler.maxSize).toArray();
  for (const lnurl of array) {
    cacheHandler.set(lnurl.pubkey, { document: lnurl.document, fetchedAt: lnurl.fetchedAt }, false);
  }
}
var zapperDump = (lnurls, debug2) => {
  return async (dirtyKeys, cache) => {
    const entries = [];
    for (const pubkey of dirtyKeys) {
      const entry = cache.get(pubkey);
      if (entry) {
        entries.push({
          pubkey,
          ...entry
        });
      }
    }
    if (entries.length) {
      debug2(`Saving ${entries.length} zapper cache entries to database`);
      await lnurls.bulkPut(entries);
    }
    dirtyKeys.clear();
  };
};

// src/lru-cache.ts
var import_typescript_lru_cache = require("typescript-lru-cache");
var CacheHandler = class {
  cache;
  dirtyKeys = /* @__PURE__ */ new Set();
  options;
  debug;
  indexes;
  isSet = false;
  maxSize = 0;
  constructor(options) {
    this.debug = options.debug;
    this.options = options;
    this.maxSize = options.maxSize;
    if (options.maxSize > 0) {
      this.cache = new import_typescript_lru_cache.LRUCache({ maxSize: options.maxSize });
      setInterval(() => this.dump().catch(console.error), 1e3 * 10);
    }
    this.indexes = /* @__PURE__ */ new Map();
  }
  getSet(key) {
    return this.cache?.get(key);
  }
  /**
   * Get all entries that match the filter.
   */
  getAllWithFilter(filter) {
    const ret = /* @__PURE__ */ new Map();
    this.cache?.forEach((val, key) => {
      if (filter(key, val)) {
        ret.set(key, val);
      }
    });
    return ret;
  }
  get(key) {
    return this.cache?.get(key);
  }
  async getWithFallback(key, table) {
    let entry = this.get(key);
    if (!entry) {
      entry = await table.get(key);
      if (entry) {
        this.set(key, entry);
      }
    }
    return entry;
  }
  async getManyWithFallback(keys, table) {
    const entries = [];
    const missingKeys = [];
    for (const key of keys) {
      const entry = this.get(key);
      if (entry) entries.push(entry);
      else missingKeys.push(key);
    }
    if (entries.length > 0) {
      this.debug(`Cache hit for keys ${entries.length} and miss for ${missingKeys.length} keys`);
    }
    if (missingKeys.length > 0) {
      const startTime = Date.now();
      const missingEntries = await table.bulkGet(missingKeys);
      const endTime = Date.now();
      let foundKeys = 0;
      for (const entry of missingEntries) {
        if (entry) {
          this.set(entry.id, entry);
          entries.push(entry);
          foundKeys++;
        }
      }
      this.debug(
        `Time spent querying database: ${endTime - startTime}ms for ${missingKeys.length} keys, which added ${foundKeys} entries to the cache`
      );
    }
    return entries;
  }
  add(key, value, dirty = true) {
    const existing = this.get(key) ?? /* @__PURE__ */ new Set();
    existing.add(value);
    this.cache?.set(key, existing);
    if (dirty) this.dirtyKeys.add(key);
  }
  set(key, value, dirty = true) {
    this.cache?.set(key, value);
    if (dirty) this.dirtyKeys.add(key);
    for (const [attribute, index] of this.indexes.entries()) {
      const indexKey = value[attribute];
      if (indexKey) {
        const indexValue = index.get(indexKey) || /* @__PURE__ */ new Set();
        indexValue.add(key);
        index.set(indexKey, indexValue);
      }
    }
  }
  size() {
    return this.cache?.size || 0;
  }
  delete(key) {
    this.cache?.delete(key);
    this.dirtyKeys.add(key);
  }
  async dump() {
    if (this.dirtyKeys.size > 0 && this.cache) {
      await this.options.dump(this.dirtyKeys, this.cache);
      this.dirtyKeys.clear();
    }
  }
  addIndex(attribute) {
    this.indexes.set(attribute, new import_typescript_lru_cache.LRUCache({ maxSize: this.options.maxSize }));
  }
  getFromIndex(index, key) {
    const ret = /* @__PURE__ */ new Set();
    const indexValues = this.indexes.get(index);
    if (indexValues) {
      const values = indexValues.get(key);
      if (values) {
        for (const key2 of values.values()) {
          const entry = this.get(key2);
          if (entry) ret.add(entry);
        }
      }
    }
    return ret;
  }
};

// src/index.ts
var INDEXABLE_TAGS_LIMIT = 10;
var NDKCacheAdapterDexie = class {
  debug;
  locking = false;
  ready = false;
  profiles;
  zappers;
  nip05s;
  events;
  eventTags;
  relayInfo;
  unpublishedEvents;
  warmedUp = false;
  warmUpPromise;
  devMode = false;
  saveSig;
  _onReady;
  moduleManager;
  constructor(opts = {}) {
    const dbName = opts.dbName || "ndk";
    createDatabase(dbName);
    this.debug = opts.debug || (0, import_debug3.default)("ndk:dexie-adapter");
    this.saveSig = opts.saveSig || false;
    this.moduleManager = new DexieCacheModuleManager(dbName);
    this.profiles = new CacheHandler({
      maxSize: opts.profileCacheSize || 1e5,
      dump: profilesDump(db.profiles, this.debug),
      debug: this.debug
    });
    this.zappers = new CacheHandler({
      maxSize: opts.zapperCacheSize || 200,
      dump: zapperDump(db.lnurl, this.debug),
      debug: this.debug
    });
    this.nip05s = new CacheHandler({
      maxSize: opts.nip05CacheSize || 1e3,
      dump: nip05Dump(db.nip05, this.debug),
      debug: this.debug
    });
    this.events = new CacheHandler({
      maxSize: opts.eventCacheSize || 5e4,
      dump: eventsDump(db.events, this.debug),
      debug: this.debug
    });
    this.events.addIndex("pubkey");
    this.events.addIndex("kind");
    this.eventTags = new CacheHandler({
      maxSize: opts.eventTagsCacheSize || 1e5,
      dump: eventTagsDump(db.eventTags, this.debug),
      debug: this.debug
    });
    this.relayInfo = new CacheHandler({
      maxSize: 500,
      debug: this.debug,
      dump: relayInfoDump(db.relayStatus, this.debug)
    });
    this.unpublishedEvents = new CacheHandler({
      maxSize: 5e3,
      debug: this.debug,
      dump: unpublishedEventsDump(db.unpublishedEvents, this.debug)
    });
    const profile = (label, fn) => {
      const start = Date.now();
      return fn().then(() => {
        const end = Date.now();
        this.debug(label, "took", end - start, "ms");
      });
    };
    const startTime = Date.now();
    this.warmUpPromise = Promise.allSettled([
      profile("profilesWarmUp", () => profilesWarmUp(this.profiles, db.profiles)),
      profile("zapperWarmUp", () => zapperWarmUp(this.zappers, db.lnurl)),
      profile("nip05WarmUp", () => nip05WarmUp(this.nip05s, db.nip05)),
      profile("relayInfoWarmUp", () => relayInfoWarmUp(this.relayInfo, db.relayStatus)),
      profile(
        "unpublishedEventsWarmUp",
        () => unpublishedEventsWarmUp(this.unpublishedEvents, db.unpublishedEvents)
      ),
      profile("eventsWarmUp", () => eventsWarmUp(this.events, db.events)),
      profile("eventTagsWarmUp", () => eventTagsWarmUp(this.eventTags, db.eventTags))
    ]);
    this.warmUpPromise.then(() => {
      const endTime = Date.now();
      this.warmedUp = true;
      this.ready = true;
      this.locking = true;
      this.debug("Warm up completed, time", endTime - startTime, "ms");
      if (this._onReady) this._onReady();
    });
  }
  onReady(callback) {
    this._onReady = callback;
  }
  async query(subscription) {
    if (!this.warmedUp) {
      const startTime2 = Date.now();
      await this.warmUpPromise;
      this.debug("froze query for", Date.now() - startTime2, "ms", subscription.filters);
    }
    const startTime = Date.now();
    subscription.filters.map((filter) => this.processFilter(filter, subscription));
    const dur = Date.now() - startTime;
    if (dur > 100) this.debug("query took", dur, "ms", subscription.filter);
    return [];
  }
  async fetchProfile(pubkey) {
    if (!this.profiles) return null;
    const user = await this.profiles.getWithFallback(pubkey, db.profiles);
    return user;
  }
  fetchProfileSync(pubkey) {
    if (!this.profiles) return null;
    const user = this.profiles.get(pubkey);
    return user;
  }
  async getProfiles(filter) {
    if (!this.profiles) return;
    const filterFn = typeof filter === "function" ? filter : (pubkey, profile) => {
      const searchLower = filter.contains.toLowerCase();
      const fields = filter.fields || (filter.field ? [filter.field] : ["name", "displayName", "nip05"]);
      return fields.some((field) => {
        const value = profile[field];
        return typeof value === "string" && value.toLowerCase().includes(searchLower);
      });
    };
    return this.profiles.getAllWithFilter(filterFn);
  }
  saveProfile(pubkey, profile) {
    const existingValue = this.profiles.get(pubkey);
    if (existingValue?.created_at && profile.created_at && existingValue.created_at >= profile.created_at) {
      return;
    }
    const cachedAt = Math.floor(Date.now() / 1e3);
    this.profiles.set(pubkey, { pubkey, ...profile, cachedAt });
    this.debug("Saved profile for pubkey", pubkey, profile);
  }
  async loadNip05(nip05, maxAgeForMissing = 3600) {
    const cache = this.nip05s?.get(nip05);
    if (cache) {
      if (cache.profile === null) {
        if (cache.fetchedAt + maxAgeForMissing * 1e3 < Date.now()) return "missing";
        return null;
      }
      try {
        return JSON.parse(cache.profile);
      } catch (_e) {
        return "missing";
      }
    }
    const nip = await db.nip05.get({ nip05 });
    if (!nip) return "missing";
    const now = Date.now();
    if (nip.profile === null) {
      if (nip.fetchedAt + maxAgeForMissing * 1e3 < now) return "missing";
      return null;
    }
    try {
      return JSON.parse(nip.profile);
    } catch (_e) {
      return "missing";
    }
  }
  async saveNip05(nip05, profile) {
    try {
      const document = profile ? JSON.stringify(profile) : null;
      this.nip05s.set(nip05, { profile: document, fetchedAt: Date.now() });
    } catch (error) {
      console.error("Failed to save NIP-05 profile for nip05:", nip05, error);
    }
  }
  async loadUsersLNURLDoc(pubkey, maxAgeInSecs = 86400, maxAgeForMissing = 3600) {
    const cache = this.zappers?.get(pubkey);
    if (cache) {
      if (cache.document === null) {
        if (cache.fetchedAt + maxAgeForMissing * 1e3 < Date.now()) return "missing";
        return null;
      }
      try {
        return JSON.parse(cache.document);
      } catch (_e) {
        return "missing";
      }
    }
    const lnurl = await db.lnurl.get({ pubkey });
    if (!lnurl) return "missing";
    const now = Date.now();
    if (lnurl.fetchedAt + maxAgeInSecs * 1e3 < now) return "missing";
    if (lnurl.document === null) {
      if (lnurl.fetchedAt + maxAgeForMissing * 1e3 < now) return "missing";
      return null;
    }
    try {
      return JSON.parse(lnurl.document);
    } catch (_e) {
      return "missing";
    }
  }
  async saveUsersLNURLDoc(pubkey, doc) {
    try {
      const document = doc ? JSON.stringify(doc) : null;
      this.zappers?.set(pubkey, { document, fetchedAt: Date.now() });
    } catch (error) {
      console.error("Failed to save LNURL document for pubkey:", pubkey, error);
    }
  }
  processFilter(filter, subscription) {
    const _filter = { ...filter };
    _filter.limit = void 0;
    const filterKeys = new Set(Object.keys(_filter || {}));
    filterKeys.delete("since");
    filterKeys.delete("limit");
    filterKeys.delete("until");
    try {
      if (this.byNip33Query(filterKeys, filter, subscription)) return;
      if (this.byAuthors(filter, subscription)) return;
      if (this.byIdsQuery(filter, subscription)) return;
      if (this.byTags(filter, subscription)) return;
      if (this.byKinds(filterKeys, filter, subscription)) return;
    } catch (error) {
      console.error(error);
    }
  }
  async deleteEventIds(eventIds) {
    eventIds.forEach((id) => this.events.delete(id));
    await db.events.where({ id: eventIds }).delete();
  }
  addUnpublishedEvent = addUnpublishedEvent.bind(this);
  getUnpublishedEvents = () => getUnpublishedEvents(db.unpublishedEvents);
  discardUnpublishedEvent = (id) => discardUnpublishedEvent(db.unpublishedEvents, id);
  async setEvent(event, _filters, relay) {
    if (event.kind === 0) {
      if (!this.profiles) return;
      try {
        const profile = (0, import_ndk2.profileFromEvent)(event);
        this.saveProfile(event.pubkey, profile);
      } catch {
        this.debug(`Failed to save profile for pubkey: ${event.pubkey}`);
      }
    }
    let addEvent = true;
    if (event.isParamReplaceable()) {
      const existingEvent = this.events.get(event.tagId());
      if (existingEvent && event.created_at && existingEvent.createdAt > event.created_at) {
        addEvent = false;
      }
    }
    if (addEvent) {
      const eventData = {
        id: event.tagId(),
        pubkey: event.pubkey,
        kind: event.kind,
        createdAt: event.created_at ?? Date.now(),
        relay: relay?.url,
        event: event.serialize(this.saveSig, true)
      };
      if (this.saveSig && event.sig) {
        eventData.sig = event.sig;
      }
      this.events.set(event.tagId(), eventData);
      const indexableTags = getIndexableTags(event);
      for (const tag of indexableTags) {
        this.eventTags.add(tag[0] + tag[1], event.tagId());
      }
      if (relay?.url) {
        db.eventRelays.put({
          eventId: event.id,
          relayUrl: relay.url,
          seenAt: Date.now()
        }).catch((e) => {
          this.debug("Failed to store relay provenance", e);
        });
      }
    }
  }
  setEventDup(event, relay) {
    if (relay?.url) {
      db.eventRelays.put({
        eventId: event.id,
        relayUrl: relay.url,
        seenAt: Date.now()
      }).catch((e) => {
        this.debug("Failed to store relay provenance for duplicate event", e);
      });
    }
  }
  updateRelayStatus(url, info) {
    const existing = this.relayInfo.get(url);
    const merged = {
      url,
      updatedAt: Date.now(),
      ...existing,
      ...info,
      metadata: {
        ...existing?.metadata,
        ...info.metadata
      }
    };
    this.relayInfo.set(url, merged);
  }
  getRelayStatus(url) {
    const a = this.relayInfo.get(url);
    if (a) {
      return {
        lastConnectedAt: a.lastConnectedAt,
        dontConnectBefore: a.dontConnectBefore,
        consecutiveFailures: a.consecutiveFailures,
        lastFailureAt: a.lastFailureAt,
        nip11: a.nip11,
        metadata: a.metadata
      };
    }
  }
  /**
   * Searches by authors
   */
  byAuthors(filter, subscription) {
    if (!filter.authors) return false;
    let _total = 0;
    for (const pubkey of filter.authors) {
      let events = Array.from(this.events.getFromIndex("pubkey", pubkey));
      if (filter.kinds) events = events.filter((e) => filter.kinds?.includes(e.kind));
      foundEvents(subscription, events, filter);
      _total += events.length;
    }
    return true;
  }
  /**
   * Searches by ids
   */
  byIdsQuery(filter, subscription) {
    if (filter.ids) {
      for (const id of filter.ids) {
        const event = this.events.get(id);
        if (event) foundEvent(subscription, event, event.relay, filter);
      }
      return true;
    }
    return false;
  }
  /**
   * Searches by NIP-33
   */
  byNip33Query(filterKeys, filter, subscription) {
    const f = ["#d", "authors", "kinds"];
    const hasAllKeys = filterKeys.size === f.length && f.every((k) => filterKeys.has(k));
    if (hasAllKeys && filter.kinds && filter.authors) {
      for (const kind of filter.kinds) {
        const replaceableKind = kind >= 3e4 && kind < 4e4;
        if (!replaceableKind) continue;
        for (const author of filter.authors) {
          for (const dTag of filter["#d"]) {
            const replaceableId = `${kind}:${author}:${dTag}`;
            const event = this.events.get(replaceableId);
            if (event) foundEvent(subscription, event, event.relay, filter);
          }
        }
      }
      return true;
    }
    return false;
  }
  /**
   * Searches by tags and optionally filters by tags
   */
  byTags(filter, subscription) {
    const tagFilters = Object.entries(filter).filter(([filter2]) => filter2.startsWith("#") && filter2.length === 2).map(([filter2, values]) => [filter2[1], values]);
    if (tagFilters.length === 0) return false;
    for (const [tag, values] of tagFilters) {
      for (const value of values) {
        const tagValue = tag + value;
        const eventIds = this.eventTags.getSet(tagValue);
        if (!eventIds) continue;
        eventIds.forEach((id) => {
          const event = this.events.get(id);
          if (!event) return;
          if (!filter.kinds || filter.kinds.includes(event.kind)) {
            foundEvent(subscription, event, event.relay, filter);
          }
        });
      }
    }
    return true;
  }
  byKinds(filterKeys, filter, subscription) {
    if (!filter.kinds || filterKeys.size !== 1 || !filterKeys.has("kinds")) return false;
    const limit = filter.limit || 500;
    let totalEvents = 0;
    const processedEventIds = /* @__PURE__ */ new Set();
    const sortedKinds = [...filter.kinds].sort(
      (a, b) => (this.events.indexes.get("kind")?.get(a)?.size || 0) - (this.events.indexes.get("kind")?.get(b)?.size || 0)
    );
    for (const kind of sortedKinds) {
      const events = this.events.getFromIndex("kind", kind);
      for (const event of events) {
        if (processedEventIds.has(event.id)) continue;
        processedEventIds.add(event.id);
        foundEvent(subscription, event, event.relay, filter);
        totalEvents++;
        if (totalEvents >= limit) break;
      }
      if (totalEvents >= limit) break;
    }
    return true;
  }
  /**
   * Register a cache module with its schema and migrations
   */
  async registerModule(module2) {
    await this.moduleManager.registerModule(module2);
  }
  /**
   * Get a collection from a registered module
   */
  async getModuleCollection(namespace, collection) {
    return await this.moduleManager.getModuleCollection(namespace, collection);
  }
  /**
   * Get a decrypted event from the cache by its wrapper ID
   */
  async getDecryptedEvent(wrapperId) {
    try {
      const decrypted = await db.decryptedEvents.get(wrapperId);
      if (decrypted) {
        const nostrEvent = JSON.parse(decrypted.event);
        return new import_ndk2.NDKEvent(void 0, nostrEvent);
      }
      return null;
    } catch (e) {
      console.error(`[cache-dexie] Error getting decrypted event for wrapper ${wrapperId}:`, e);
      return null;
    }
  }
  /**
   * Add a decrypted event to the cache
   */
  async addDecryptedEvent(wrapperId, decryptedEvent) {
    try {
      await db.decryptedEvents.put({
        id: wrapperId,
        event: JSON.stringify(decryptedEvent.rawEvent())
      });
    } catch (e) {
      console.error(`[cache-dexie] Error adding decrypted event for wrapper ${wrapperId}:`, e);
    }
  }
};
function foundEvents(subscription, events, filter) {
  if (filter?.limit && events.length > filter.limit) {
    events = events.sort((a, b) => b.createdAt - a.createdAt).slice(0, filter.limit);
  }
  for (const event of events) {
    foundEvent(subscription, event, event.relay, filter);
  }
}
function foundEvent(subscription, event, relayUrl, filter) {
  try {
    const deserializedEvent = (0, import_ndk2.deserialize)(event.event);
    if (filter && !(0, import_nostr_tools.matchFilter)(filter, deserializedEvent)) return;
    const ndkEvent = new import_ndk2.NDKEvent(void 0, deserializedEvent);
    const relay = relayUrl ? subscription.pool.getRelay(relayUrl, false) : void 0;
    ndkEvent.relay = relay;
    subscription.eventReceived(ndkEvent, relay, true);
  } catch (e) {
    console.error("failed to deserialize event", e);
  }
}
function getIndexableTags(event) {
  const indexableTags = [];
  if (event.kind === 3) return [];
  for (const tag of event.tags) {
    if (tag[0].length !== 1) continue;
    indexableTags.push(tag);
    if (indexableTags.length >= INDEXABLE_TAGS_LIMIT) return [];
  }
  return indexableTags;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  db,
  foundEvent,
  foundEvents
});
