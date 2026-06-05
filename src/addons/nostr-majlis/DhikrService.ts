/**
 * DhikrService - Community Dhikr data layer (M3), addon-local (like NoteTakingSyncService).
 *
 * Owns two live subscriptions, BOTH pinned to the hardcoded DHIKR_RELAYS only (no outbox, no
 * aggregated relays, no user relays): rounds (#t round-label) and commits (#t commit-label).
 * It keeps the latest round per address and the latest commit per (author, d-tag), so progress =
 * sum of commit counts. Publishing also targets only those two relays. Signed-in posts go through
 * AuthService; anonymous posts are signed with a one-time key via the adapter (deliberately not
 * the user's identity). Owned by the runtime → destroy() closes the subscriptions and clears state.
 */

import type { NDKFilter, NostrEvent } from '@nostr-dev-kit/ndk';
import { NostrTransport } from '../../services/transport/NostrTransport';
import { AuthService } from '../../services/AuthService';
import {
  generateSecretKey, getPublicKeyFromPrivate, bytesToHex, calculateEventHash, signEventWithKey,
  type UnsignedEvent,
} from '../../services/NostrToolsAdapter';
import { diagLog } from '../../services/DiagnosticLogger';
import {
  DHIKR_RELAYS, DHIKR_KIND, ROUND_LABEL, COMMIT_LABEL,
  parseRound, parseCommit, buildRoundDraft, buildCommitDraft, stableCommitDtag,
  type DhikrRound, type DhikrCommit, type DraftEvent,
} from './dhikr';

interface SubCloser { close: () => void; }

export class DhikrService {
  private transport = NostrTransport.getInstance();
  private roundSub: SubCloser | null = null;
  private commitSub: SubCloser | null = null;

  private rounds = new Map<string, DhikrRound>();                 // addr -> latest round
  private commits = new Map<string, Map<string, DhikrCommit>>();  // addr -> (author:dtag -> latest commit)
  private listeners = new Set<() => void>();
  private emitTimer: number | null = null;

  async start(): Promise<void> {
    const roundFilter: NDKFilter[] = [{ kinds: [DHIKR_KIND], '#t': [ROUND_LABEL] }];
    const commitFilter: NDKFilter[] = [{ kinds: [DHIKR_KIND], '#t': [COMMIT_LABEL] }];

    this.roundSub = await this.transport.subscribe(DHIKR_RELAYS, roundFilter, {
      onEvent: (ev) => this.ingestRound(ev),
    });
    this.commitSub = await this.transport.subscribe(DHIKR_RELAYS, commitFilter, {
      onEvent: (ev) => this.ingestCommit(ev),
    });
    diagLog('addons', 'nostr-majlis: dhikr service started');
  }

  // ---------- ingestion ----------

  private ingestRound(ev: NostrEvent): void {
    const round = parseRound(ev);
    if (!round) return;
    const existing = this.rounds.get(round.addr);
    if (existing && existing.createdAt >= round.createdAt) return; // keep the latest (replaceable)
    this.rounds.set(round.addr, round);
    this.scheduleEmit();
  }

  private ingestCommit(ev: NostrEvent): void {
    const commit = parseCommit(ev);
    if (!commit) return;
    this.addCommit(commit);
    this.scheduleEmit();
  }

  private addCommit(commit: DhikrCommit): void {
    let bucket = this.commits.get(commit.roundAddr);
    if (!bucket) { bucket = new Map(); this.commits.set(commit.roundAddr, bucket); }
    const key = `${commit.author}:${commit.dtag}`;
    const existing = bucket.get(key);
    if (existing && existing.createdAt >= commit.createdAt) return; // replaceable → newest wins
    bucket.set(key, commit);
  }

  // ---------- reads ----------

  /** Rounds, newest first. */
  getRounds(): DhikrRound[] {
    return [...this.rounds.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Sum of all commit counts for a round. */
  getTotal(addr: string): number {
    const bucket = this.commits.get(addr);
    if (!bucket) return 0;
    let sum = 0;
    for (const c of bucket.values()) sum += c.count;
    return sum;
  }

  /** The signed-in user's current (non-anonymous) count for a round, for cumulative commits. */
  private myCount(round: DhikrRound): number {
    const me = AuthService.getInstance().getCurrentUser()?.pubkey;
    if (!me) return 0;
    return this.commits.get(round.addr)?.get(`${me}:${stableCommitDtag(round)}`)?.count ?? 0;
  }

  // ---------- writes ----------

  /** Create a new dhikr action. */
  async publishRound(phrase: string, goal: number, description: string, anon: boolean): Promise<void> {
    const event = await this.sign(buildRoundDraft(phrase, goal, description, anon), anon);
    await this.transport.publish(DHIKR_RELAYS, event);
    this.ingestRound(event); // optimistic: show it to the author immediately
    diagLog('addons', 'nostr-majlis: dhikr round published', { anon });
  }

  /** Add `amount` to the round's pot (cumulative for a signed-in user, standalone when anonymous). */
  async commit(round: DhikrRound, amount: number, anon: boolean): Promise<void> {
    const total = anon ? amount : this.myCount(round) + amount;
    const event = await this.sign(buildCommitDraft(round, total, anon), anon);
    await this.transport.publish(DHIKR_RELAYS, event);
    this.ingestCommit(event);
    diagLog('addons', 'nostr-majlis: dhikr commit published', { anon, amount });
  }

  private async sign(draft: DraftEvent, anon: boolean): Promise<NostrEvent> {
    if (!anon) return await AuthService.getInstance().signEvent(draft) as NostrEvent;
    // Anonymous: one-time key, signed via the adapter (deliberately NOT the user's identity).
    const skHex = bytesToHex(generateSecretKey());
    const pubkey = getPublicKeyFromPrivate(skHex);
    const unsigned = { ...draft, pubkey } as UnsignedEvent;
    const id = calculateEventHash(unsigned);
    const sig = signEventWithKey(unsigned, skHex);
    return { ...unsigned, id, sig } as NostrEvent;
  }

  // ---------- change notification ----------

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Coalesce bursts of incoming events into a single notification. */
  private scheduleEmit(): void {
    if (this.emitTimer !== null) return;
    this.emitTimer = window.setTimeout(() => {
      this.emitTimer = null;
      for (const cb of this.listeners) cb();
    }, 200);
  }

  destroy(): void {
    if (this.emitTimer !== null) { clearTimeout(this.emitTimer); this.emitTimer = null; }
    this.roundSub?.close(); this.roundSub = null;
    this.commitSub?.close(); this.commitSub = null;
    this.rounds.clear();
    this.commits.clear();
    this.listeners.clear();
    diagLog('addons', 'nostr-majlis: dhikr service destroyed');
  }
}
