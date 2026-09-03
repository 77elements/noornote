/**
 * RemoteMuteCheckService
 *
 * Single source of truth for "has user X PUBLICLY muted the current user?"
 * Read-only sibling of FollowVerificationService — mirrors its relay strategy
 * and caching, but reads NIP-51 kind:10000 (mute list) instead of kind:3.
 *
 * Scope & privacy:
 *   - PUBLIC mutes only. A kind:10000 carries public entries as plaintext `p`
 *     tags and private entries NIP-04/44-encrypted in `.content`. The private
 *     part is only decryptable by its owner, so a remote observer can never
 *     read it — by design. We therefore only ever detect a public mute.
 *   - Verdict is tri-state: 'muted' / 'not-muted' / 'unknown'. A missing
 *     kind:10000 is 'unknown', NEVER 'not-muted' — we simply don't know.
 *   - This service NEVER touches the list-sync layer (src/lists/*). It is a
 *     pure relay read; it does not read, write or migrate the user's own lists.
 *
 * Consumers render a badge only on the definitive 'muted' verdict; 'not-muted'
 * and 'unknown' both collapse to "no badge".
 */

import { RemoteKindVerdictService } from './RemoteKindVerdictService';
import { diagLog } from './DiagnosticLogger';

export type MuteVerdict =
  | { status: 'muted'; verifiedAt: number; viaRelays: string[] }
  | { status: 'not-muted'; verifiedAt: number; viaRelays: string[] }
  | {
      status: 'unknown';
      reason: 'no-write-relays' | 'no-event' | 'timeout' | 'error';
    };

export class RemoteMuteCheckService extends RemoteKindVerdictService<MuteVerdict> {
  private static instance: RemoteMuteCheckService;

  private constructor() {
    super();
  }

  protected get kind(): number {
    return 10000;
  }

  protected get logTag(): string {
    return 'RemoteMuteCheck';
  }

  public static getInstance(): RemoteMuteCheckService {
    if (!RemoteMuteCheckService.instance) {
      RemoteMuteCheckService.instance = new RemoteMuteCheckService();
    }
    return RemoteMuteCheckService.instance;
  }

  /**
   * Has `theirPubkey` publicly muted the current user?
   * Tri-state — see MuteVerdict.
   */
  public async verifyMutedByThem(
    theirPubkey: string,
    opts: { forceRefresh?: boolean } = {}
  ): Promise<MuteVerdict> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      return { status: 'unknown', reason: 'error' };
    }

    return this.verifyCached(theirPubkey, currentUser.pubkey, opts, () =>
      this.performCheck(
        theirPubkey,
        currentUser.pubkey,
        opts.forceRefresh ?? false
      )
    );
  }

  /**
   * Boolean wrapper for UI where 'unknown'/'not-muted' both collapse to
   * "no badge".
   */
  public async mutedByThemSimple(
    theirPubkey: string,
    opts?: { forceRefresh?: boolean }
  ): Promise<boolean> {
    const verdict = await this.verifyMutedByThem(theirPubkey, opts);
    return verdict.status === 'muted';
  }

  private async performCheck(
    theirPubkey: string,
    myPubkey: string,
    forceRefresh: boolean
  ): Promise<MuteVerdict> {
    const fetched = await this.fetchNewestKindEvent(theirPubkey, forceRefresh);

    // Fetch-phase failure: shape-compatible with MuteVerdict's unknown variant.
    if ('status' in fetched) return fetched as MuteVerdict;

    const { newest, queryRelays } = fetched;

    // Public mutes only — plaintext `p` tags. The encrypted `.content` block
    // (private mutes) is intentionally not touched; it isn't ours to decrypt.
    const mutesMe = newest.tags.some(
      tag => tag[0] === 'p' && tag[1] === myPubkey
    );

    if (mutesMe) {
      diagLog('system', 'Remote public mute detected', {
        target: theirPubkey.slice(0, 8),
        viaRelays: queryRelays.length,
      });
      return {
        status: 'muted',
        verifiedAt: Date.now(),
        viaRelays: queryRelays,
      };
    }

    return {
      status: 'not-muted',
      verifiedAt: Date.now(),
      viaRelays: queryRelays,
    };
  }
}
