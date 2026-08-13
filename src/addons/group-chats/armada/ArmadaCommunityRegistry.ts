/**
 * ArmadaCommunityRegistry — CRUD for tracked Concord communities.
 *
 * Backed by PerAccountLocalStorage (`ARMADA_COMMUNITIES` key), stored as a
 * `Record<naddr, TrackedCommunity>` map. Per-account isolation is handled by
 * PerAccountLocalStorage automatically (each user gets their own map).
 *
 * This registry is the single source of truth for "which Armada communities
 * does this user track?". Sprint 4's ArmadaService.tick() reads it to decide
 * which relays to poll; the settings UI reads it to render the community
 * list; the "remove" action deletes from here.
 */

import { PerAccountLocalStorage, StorageKeys } from '../../../services/PerAccountLocalStorage';
import type { TrackedCommunity } from './types';

export class ArmadaCommunityRegistry {
  private static instance: ArmadaCommunityRegistry | null = null;
  private storage: PerAccountLocalStorage;

  private constructor() {
    this.storage = PerAccountLocalStorage.getInstance();
  }

  public static getInstance(): ArmadaCommunityRegistry {
    if (!ArmadaCommunityRegistry.instance) {
      ArmadaCommunityRegistry.instance = new ArmadaCommunityRegistry();
    }
    return ArmadaCommunityRegistry.instance;
  }

  /** Null the singleton — for the addon destroy contract (account switch). */
  public static clearInstance(): void {
    ArmadaCommunityRegistry.instance = null;
  }

  /** Read the full registry as a Map (naddr → community). */
  private readMap(): Record<string, TrackedCommunity> {
    return this.storage.get<Record<string, TrackedCommunity>>(StorageKeys.ARMADA_COMMUNITIES, {}) ?? {};
  }

  /** Write the full registry map. */
  private writeMap(map: Record<string, TrackedCommunity>): void {
    this.storage.set(StorageKeys.ARMADA_COMMUNITIES, map);
  }

  /** List all tracked communities, sorted by name. */
  public list(): TrackedCommunity[] {
    const map = this.readMap();
    return Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Get one community by its naddr, or undefined. */
  public get(naddr: string): TrackedCommunity | undefined {
    return this.readMap()[naddr];
  }

  /**
   * Add (or replace) a tracked community. If a community with the same naddr
   * already exists, it is overwritten (re-import with a fresh invite link).
   * Returns the stored community.
   */
  public add(community: TrackedCommunity): TrackedCommunity {
    const map = this.readMap();
    map[community.naddr] = community;
    this.writeMap(map);
    return community;
  }

  /** Remove a tracked community by its naddr. Returns true if it existed. */
  public remove(naddr: string): boolean {
    const map = this.readMap();
    if (!(naddr in map)) return false;
    delete map[naddr];
    this.writeMap(map);
    return true;
  }

  /** Whether the user tracks ANY community. */
  public isEmpty(): boolean {
    return Object.keys(this.readMap()).length === 0;
  }

  /** Count of tracked communities. */
  public count(): number {
    return Object.keys(this.readMap()).length;
  }

  /**
   * Update the `lastCheckedAt` anchor for a community after a poll tick.
   * Used by Sprint 4's ArmadaService.
   */
  public setCheckedAt(naddr: string, checkedAtSeconds: number): void {
    const map = this.readMap();
    const c = map[naddr];
    if (!c) return;
    c.lastCheckedAt = checkedAtSeconds;
    this.writeMap(map);
  }
}
