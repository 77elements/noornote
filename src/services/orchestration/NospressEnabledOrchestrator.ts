/**
 * NospressEnabledOrchestrator
 *
 * Tiny NIP-78 (kind:30078) opt-in marker under d-tag
 * `noornote/nospress-enabled`. Published when the user enables the
 * NosPress addon, deleted (kind:5) when they disable it.
 *
 * Purpose: give the public-page boot flow a relay-visible signal so
 * `noornote.app/<handle>/` only resolves for users who deliberately
 * activated NosPress. Without this gate the route would serve a
 * "Made with NoorNote" empty-state to every Nostr identity with a
 * resolvable NIP-05 / npub — even ones who never installed our app.
 *
 * Lives outside the addon runtime: NospressSettings reads + writes it
 * from the settings page (always present, regardless of addon state),
 * and PublicNospressPage reads it on every public-route boot.
 */

import { Nip78ResourceOrchestrator } from './Nip78ResourceOrchestrator';

export interface NospressEnabledMarker {
  version: 1;
  enabledAt: number;
}

function isMarker(value: unknown): value is NospressEnabledMarker {
  if (typeof value !== 'object' || value === null) return false;
  const v = (value as { version?: unknown; enabledAt?: unknown });
  return v.version === 1 && typeof v.enabledAt === 'number';
}

export class NospressEnabledOrchestrator {
  private static instance: NospressEnabledOrchestrator | null = null;
  private resource: Nip78ResourceOrchestrator<NospressEnabledMarker>;

  private constructor() {
    this.resource = new Nip78ResourceOrchestrator<NospressEnabledMarker>({
      name: 'NospressEnabledOrchestrator',
      fetchLabel: 'NospressEnabledOrch',
      dTagFor: () => 'noornote/nospress-enabled',
      parse: (content) => {
        if (!content) return null;
        try {
          const parsed = JSON.parse(content);
          return isMarker(parsed) ? parsed : null;
        } catch { return null; }
      },
    });
  }

  public static getInstance(): NospressEnabledOrchestrator {
    if (!NospressEnabledOrchestrator.instance) {
      NospressEnabledOrchestrator.instance = new NospressEnabledOrchestrator();
    }
    return NospressEnabledOrchestrator.instance;
  }

  public destroy(): void {
    this.resource.destroyCache();
    NospressEnabledOrchestrator.instance = null;
  }

  /** Publish the opt-in marker. Idempotent — replays just bump the
   *  timestamp via NIP-78 replaceable semantics. */
  public async publishToRelays(): Promise<void> {
    await this.resource.publish({ version: 1, enabledAt: Math.floor(Date.now() / 1000) }, '');
  }

  /** NIP-09 deletion of the opt-in marker. After this, the public
   *  route at `noornote.app/<handle>/` will resolve to "Page not found"
   *  on relays that honour kind:5 deletions. */
  public async deleteFromRelays(): Promise<void> {
    await this.resource.delete('');
  }

  /** Fetch the marker for an arbitrary pubkey — public visitors use
   *  this to gate the route. Returns null if the user never opted in
   *  (or has since opted out). */
  public async fetchFromRelays(pubkey: string, forceRefresh: boolean = false): Promise<NospressEnabledMarker | null> {
    return this.resource.fetch(pubkey, '', forceRefresh);
  }

  public clearCache(pubkey?: string): void {
    this.resource.clearCache(pubkey);
  }
}
