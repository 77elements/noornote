/**
 * DhikrService - Community Dhikr data layer (M3), addon-local (like NoteTakingSyncService).
 *
 * Owns three live subscriptions, ALL pinned to the hardcoded DHIKR_RELAYS only (no outbox, no
 * aggregated relays, no user relays): rounds (#t round-label), commits (#t commit-label) and the
 * admin moderation record (#t moderation-label, admin author only). It keeps the latest round per
 * address and the latest commit per (author, d-tag), so progress = sum of commit counts. Moderation
 * hides rounds, invalidates banned authors' submissions and applies per-round field overrides.
 * Publishing also targets only those two relays. Signed-in posts go through AuthService; anonymous
 * posts are signed with a one-time key via the adapter (deliberately not the user's identity).
 * Owned by the runtime → destroy() closes the subscriptions and clears state.
 */

import type { NDKFilter, NostrEvent } from '@nostr-dev-kit/ndk';
import { NostrTransport } from '../../services/transport/NostrTransport';
import { TypedEventBus } from '../../core/TypedEventBus';
import { AuthService } from '../../services/AuthService';
import { diagLog } from '../../services/DiagnosticLogger';
import {
  DHIKR_RELAYS, DHIKR_KIND, ROUND_LABEL, COMMIT_LABEL,
  parseRound, parseCommit, buildRoundDraft, buildCommitDraft, stableCommitDtag,
  type DhikrRound, type DhikrCommit,
} from './dhikr';
import {
  DHIKR_ADMIN_PUBKEY, MODERATION_LABEL, EMPTY_MODERATION,
  parseModeration, buildModerationDraft, type DhikrModeration,
} from './dhikrModeration';
import { getNostrMajlisSettings } from './index';

const ROUND_SUB_ID = 'nostr-majlis-dhikr-rounds';
const COMMIT_SUB_ID = 'nostr-majlis-dhikr-commits';
const MOD_SUB_ID = 'nostr-majlis-dhikr-moderation';

/** What an ingested commit changed, so the live path can decide whether to notify. */
interface DhikrCommitChange {
  commit: DhikrCommit;
  round: DhikrRound | null;
  delta: number;        // this commit's added amount (new cumulative − previous cumulative)
  oldAggregate: number; // round total before this commit
  newAggregate: number; // round total after this commit
}

export class DhikrService {
  private transport = NostrTransport.getInstance();
  private bus = TypedEventBus.getInstance();

  private rounds = new Map<string, DhikrRound>();                 // addr -> latest round
  private commits = new Map<string, Map<string, DhikrCommit>>();  // addr -> (author:dtag -> latest commit)
  private moderation: DhikrModeration = EMPTY_MODERATION;
  private emitTimer: number | null = null;
  private loaded = false; // false until the initial fetch has returned
  // Notifications only fire for activity newer than this (set once the initial backfill is in), so a
  // failed/partial fetch or any reconnect/restart replay of historical events can never flood the feed.
  private notifyFloor = 0;

  /** True once the initial fetch finished (so an empty list means "none" rather than "still loading"). */
  isLoaded(): boolean {
    return this.loaded;
  }

  async start(): Promise<void> {
    // These relays aren't in the user's list, so pool + connect them explicitly first; otherwise
    // NDK won't reach them via relayUrls (subscribe) or pool.getRelay (publish).
    await this.ensureRelays();

    const roundFilter: NDKFilter[] = [{ kinds: [DHIKR_KIND], '#t': [ROUND_LABEL] }];
    const commitFilter: NDKFilter[] = [{ kinds: [DHIKR_KIND], '#t': [COMMIT_LABEL] }];
    const moderationFilter: NDKFilter[] = [{ kinds: [DHIKR_KIND], authors: [DHIKR_ADMIN_PUBKEY], '#t': [MODERATION_LABEL] }];

    // Initial load: fetch() force-pools the relays and returns stored events reliably.
    try {
      const events = await this.transport.fetch(DHIKR_RELAYS, [...roundFilter, ...commitFilter, ...moderationFilter], 6000, true, 'dhikr');
      for (const ev of events) { this.ingestRound(ev); this.ingestCommit(ev); this.ingestModeration(ev); }
    } catch { /* live subscription will still fill in */ }
    this.loaded = true;
    this.notifyFloor = Math.floor(Date.now() / 1000);
    this.emit();

    // Live updates via subscribeLive: it registers in the transport's subscription map, so the
    // pool-pruner keeps these two relays alive (a plain subscribe() would let them be pruned).
    await this.transport.subscribeLive(DHIKR_RELAYS, roundFilter, ROUND_SUB_ID, (ev) => {
      const round = this.ingestRound(ev); if (round) this.maybeNotifyRound(round);
      this.scheduleEmit();
    });
    await this.transport.subscribeLive(DHIKR_RELAYS, commitFilter, COMMIT_SUB_ID, (ev) => {
      const change = this.ingestCommit(ev); if (change) this.maybeNotifyCommit(change);
      this.scheduleEmit();
    });
    await this.transport.subscribeLive(DHIKR_RELAYS, moderationFilter, MOD_SUB_ID, (ev) => {
      this.ingestModeration(ev); this.scheduleEmit();
    });
    diagLog('addons', 'nostr-majlis: dhikr service started', { rounds: this.rounds.size });
  }

  // ---------- ingestion (state only; callers decide when to emit) ----------

  private ingestRound(ev: NostrEvent): DhikrRound | null {
    const round = parseRound(ev);
    if (!round) return null;
    const existing = this.rounds.get(round.addr);
    if (existing && existing.createdAt >= round.createdAt) return null; // keep the latest (replaceable)
    this.rounds.set(round.addr, round);
    return existing ? null : round; // only a brand-new round is notification-worthy (edits aren't "new")
  }

  private ingestCommit(ev: NostrEvent): DhikrCommitChange | null {
    const commit = parseCommit(ev);
    if (!commit) return null;
    const key = `${commit.author}:${commit.dtag}`;
    const existing = this.commits.get(commit.roundAddr)?.get(key);
    if (existing && existing.createdAt >= commit.createdAt) return null; // replaceable → newest wins (dedup/echo)
    const oldUserCount = existing?.count ?? 0;
    const oldAggregate = this.getTotal(commit.roundAddr);
    this.addCommit(commit);
    return {
      commit,
      round: this.rounds.get(commit.roundAddr) ?? null,
      delta: commit.count - oldUserCount,
      oldAggregate,
      newAggregate: this.getTotal(commit.roundAddr),
    };
  }

  private ingestModeration(ev: NostrEvent): void {
    const m = parseModeration(ev);
    if (!m) return;
    if (m.createdAt < this.moderation.createdAt) return; // replaceable → newest record wins
    this.moderation = m;
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

  /**
   * Rounds, newest first. Field overrides are applied. By default moderated rounds (hidden, or by a
   * banned author) are filtered out — what every user sees. Pass includeModerated=true (admin view)
   * to keep them, so the admin can still see and reverse a moderation action.
   */
  getRounds(includeModerated = false): DhikrRound[] {
    const hidden = new Set(this.moderation.hiddenRounds);
    const banned = new Set(this.moderation.bannedAuthors);
    return [...this.rounds.values()]
      .filter(r => includeModerated || (!hidden.has(r.addr) && !banned.has(r.author)))
      .map(r => this.applyOverride(r))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Merge any admin override (phrase/goal/description) onto a round. */
  private applyOverride(r: DhikrRound): DhikrRound {
    const o = this.moderation.overrides[r.addr];
    if (!o) return r;
    return {
      ...r,
      phrase: o.phrase ?? r.phrase,
      goal: o.goal ?? r.goal,
      description: o.description ?? r.description,
    };
  }

  /** Sum of all commit counts for a round, EXCLUDING banned authors (their submissions don't count). */
  getTotal(addr: string): number {
    const bucket = this.commits.get(addr);
    if (!bucket) return 0;
    const banned = new Set(this.moderation.bannedAuthors);
    let sum = 0;
    for (const c of bucket.values()) if (!banned.has(c.author)) sum += c.count;
    return sum;
  }

  // ---------- moderation reads ----------

  /** True if the signed-in user is the dhikr admin (only then are the moderation controls shown). */
  isAdmin(): boolean {
    const me = AuthService.getInstance().getCurrentUser()?.pubkey;
    return !!me && me === DHIKR_ADMIN_PUBKEY;
  }

  isHidden(addr: string): boolean {
    return this.moderation.hiddenRounds.includes(addr);
  }

  isAuthorBanned(pubkey: string): boolean {
    return this.moderation.bannedAuthors.includes(pubkey);
  }

  /** The signed-in user's current (non-anonymous) count for a round, for cumulative commits. */
  private myCount(round: DhikrRound): number {
    const me = AuthService.getInstance().getCurrentUser()?.pubkey;
    if (!me) return 0;
    return this.commits.get(round.addr)?.get(`${me}:${stableCommitDtag(round)}`)?.count ?? 0;
  }

  // ---------- writes ----------

  /** Create a new dhikr action. */
  async publishRound(phrase: string, goal: number, description: string): Promise<void> {
    await this.ensureRelays();
    const event = await AuthService.getInstance().signEvent(buildRoundDraft(phrase, goal, description)) as NostrEvent;
    await this.transport.publish(DHIKR_RELAYS, event);
    const round = this.ingestRound(event); if (round) this.maybeNotifyRound(round);
    this.emit(); // optimistic: show it to the author immediately (they get the anonymous ping too)
    diagLog('addons', 'nostr-majlis: dhikr round published');
  }

  /** Add `amount` to the round's pot (cumulative across the user's commits). */
  async commit(round: DhikrRound, amount: number): Promise<void> {
    await this.ensureRelays();
    const total = this.myCount(round) + amount;
    const event = await AuthService.getInstance().signEvent(buildCommitDraft(round, total)) as NostrEvent;
    await this.transport.publish(DHIKR_RELAYS, event);
    const change = this.ingestCommit(event); if (change) this.maybeNotifyCommit(change);
    this.emit();
    diagLog('addons', 'nostr-majlis: dhikr commit published', { amount });
  }

  // ---------- moderation writes (admin only; non-admin records are ignored by every client) ----------

  /** Hide a round from the list for everyone (reversible). */
  async hideRound(addr: string): Promise<void> {
    if (this.moderation.hiddenRounds.includes(addr)) return;
    await this.publishModeration({ ...this.moderation, hiddenRounds: [...this.moderation.hiddenRounds, addr] });
  }

  /** Un-hide a previously hidden round. */
  async unhideRound(addr: string): Promise<void> {
    await this.publishModeration({ ...this.moderation, hiddenRounds: this.moderation.hiddenRounds.filter(a => a !== addr) });
  }

  /** Exclude an author: their rounds disappear and their commit counts stop counting everywhere. */
  async banAuthor(pubkey: string): Promise<void> {
    if (this.moderation.bannedAuthors.includes(pubkey)) return;
    await this.publishModeration({ ...this.moderation, bannedAuthors: [...this.moderation.bannedAuthors, pubkey] });
  }

  /** Re-include a previously excluded author. */
  async unbanAuthor(pubkey: string): Promise<void> {
    await this.publishModeration({ ...this.moderation, bannedAuthors: this.moderation.bannedAuthors.filter(p => p !== pubkey) });
  }

  /** Override a round's displayed phrase/goal/description (the underlying event is left untouched). */
  async editRound(round: DhikrRound, fields: { phrase: string; goal: number; description: string }): Promise<void> {
    const overrides = { ...this.moderation.overrides, [round.addr]: { phrase: fields.phrase, goal: fields.goal, description: fields.description } };
    await this.publishModeration({ ...this.moderation, overrides });
  }

  /** Sign + publish the replaceable moderation record, then ingest it optimistically. */
  private async publishModeration(next: DhikrModeration): Promise<void> {
    await this.ensureRelays();
    const event = await AuthService.getInstance().signEvent(buildModerationDraft(next)) as NostrEvent;
    await this.transport.publish(DHIKR_RELAYS, event);
    this.ingestModeration(event); this.emit();
    diagLog('addons', 'nostr-majlis: dhikr moderation updated', {
      hidden: next.hiddenRounds.length, banned: next.bannedAuthors.length, overrides: Object.keys(next.overrides).length,
    });
  }

  /** Pool + connect the two dhikr relays (idempotent); they're not in the user's relay list. */
  private async ensureRelays(): Promise<void> {
    await Promise.all(DHIKR_RELAYS.map(url => this.transport.connectToRelay(url).catch(() => false)));
  }

  // ---------- change notification (via EventBus, so the view never depends on the
  // service existing when it subscribes) ----------

  private emit(): void {
    this.bus.emit('nostr-majlis:dhikr-changed');
  }

  /** Coalesce bursts of incoming live events into a single notification. */
  private scheduleEmit(): void {
    if (this.emitTimer !== null) return;
    this.emitTimer = window.setTimeout(() => { this.emitTimer = null; this.emit(); }, 200);
  }

  // ---------- activity notifications (synthetic kind 99003, never published; in-app feed only) ----------
  //
  // Called both from the live subscriptions (others' events) and from the user's own publish/commit
  // path, so the committer sees the SAME anonymous notification as everyone else — no author is ever
  // singled out, so a missing notification can't hint at who committed. Only fires when an ingest
  // actually changed state, so the initial backfill and reconnect/restart replays stay silent.
  // Setting gate + moderation checks are applied here.

  /** A genuinely-new round → one anonymous "new dhikr" notification (creator included). */
  private maybeNotifyRound(round: DhikrRound): void {
    if (round.createdAt < this.notifyFloor) return;                      // historical / replayed → not new activity
    if (this.isHidden(round.addr) || this.isAuthorBanned(round.author)) return;
    this.notify('dhikr_round', `round-${round.uuid}`);
  }

  /** A significant commit (>0.5% of the goal), or the one commit that reaches the goal. */
  private maybeNotifyCommit(change: DhikrCommitChange): void {
    const { round, commit, delta, oldAggregate, newAggregate } = change;
    if (!round) return;                                                  // round not loaded yet → can't judge
    if (commit.createdAt < this.notifyFloor) return;                     // historical / replayed → not new activity
    if (this.isHidden(round.addr) || this.isAuthorBanned(commit.author)) return;
    if (oldAggregate < round.goal && newAggregate >= round.goal) {
      this.notify('dhikr_complete', `complete-${round.uuid}`);
    } else if (delta > round.goal * 0.005) {
      // uuid + resulting count: stable for dedup, but carries no committer pubkey (keeps it anonymous).
      this.notify('dhikr_commit', `commit-${round.uuid}-${commit.count}`);
    }
  }

  /** Build the synthetic (never-published) notification event and hand it to the orchestrator. */
  private notify(type: 'dhikr_round' | 'dhikr_commit' | 'dhikr_complete', idSuffix: string): void {
    if (!getNostrMajlisSettings().dhikrNotifications) return;
    const event: NostrEvent = {
      id: `dhikr-${idSuffix}`,
      pubkey: '',
      kind: 99003,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['type', type]],
      content: '',
      sig: '',
    };
    this.bus.emit('dhikr-notification:new', { event, type });
  }

  destroy(): void {
    if (this.emitTimer !== null) { clearTimeout(this.emitTimer); this.emitTimer = null; }
    this.transport.unsubscribeLive(ROUND_SUB_ID);
    this.transport.unsubscribeLive(COMMIT_SUB_ID);
    this.transport.unsubscribeLive(MOD_SUB_ID);
    this.rounds.clear();
    this.commits.clear();
    this.moderation = EMPTY_MODERATION;
    diagLog('addons', 'nostr-majlis: dhikr service destroyed');
  }
}
