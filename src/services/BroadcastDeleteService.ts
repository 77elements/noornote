/**
 * BroadcastDeleteService — Background broadcast of NIP-09 deletion events
 *
 * After the normal delete (to user's own relays), this service broadcasts
 * the signed Kind-5 event to 150+ known relays in the background.
 *
 * Relay source: Hardcoded list of known public relays (merged from multiple sources).
 * WebSockets have no CORS restrictions, so this works from any origin.
 *
 * The broadcast is fire-and-forget — errors don't affect the app.
 * Only SystemLog messages indicate progress (no UI, no toasts).
 */

import { SystemLogger } from '../components/system/SystemLogger';
import { RelayConfig } from './RelayConfig';

/** Signed Nostr event structure for WebSocket broadcasting */
interface SignedNostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/**
 * Known public relays for broadcast deletion.
 * Merged from delete.nostr.com + additional well-known relays, deduplicated.
 * Many of these may be offline — that's OK, the broadcast is best-effort.
 */
const BROADCAST_RELAYS = [
  // Major relays (high availability)
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.snort.social',
  'wss://offchain.pub',
  'wss://nostr.wine',
  'wss://relay.mostr.pub',
  'wss://nostr.mom',
  'wss://relay.nostr.bg',
  'wss://nostr21.com',
  'wss://relayable.org',
  'wss://purplepag.es',
  'wss://relay.primal.net',
  'wss://nostr.oxtr.dev',
  'wss://relay.nostr.net',
  'wss://nostr.bitcoiner.social',
  'wss://nostr.lu.ke',
  'wss://nostr.mutinywallet.com',
  'wss://relay.taxi',
  // From delete.nostr.com relay list
  'wss://relay.current.fyi',
  'wss://relay.wellorder.net',
  'wss://nostr-pub.wellorder.net',
  'wss://e.nos.lol',
  'wss://no.str.cr',
  'wss://relay.nostrview.com',
  'wss://nostr.einundzwanzig.space',
  'wss://nostr.relayer.se',
  'wss://relay.austrich.net',
  'wss://nostr.cercatrova.me',
  'wss://nostr.vulpem.com',
  'wss://nostr.1729.cloud',
  'wss://eden.nostr.land',
  'wss://nostr-relay.freedomnode.com',
  'wss://nostr.klabo.blog',
  'wss://sg.qemura.xyz',
  'wss://nostr-relay.xbytez.io',
  'wss://relay.nostr.wirednet.jp',
  'wss://nostr.swiss-enigma.ch',
  'wss://relay.t5y.ca',
  'wss://nostr.test.aesyc.io',
  'wss://nostr.thomascdnns.com',
  'wss://relay.nostr.scot',
  'wss://relay.zeh.app',
  'wss://nostr.supremestack.xyz',
  'wss://relay.nostr.net.in',
  'wss://eosla.com',
  'wss://nostr.data.haus',
  'wss://nostr.mouton.dev',
  'wss://relay.nostr.vet',
  'wss://nostr.massmux.com',
  'wss://nostr-relay.alekberg.net',
  'wss://nostrical.com',
  'wss://relay.nostrgraph.net',
  'wss://relay.sendstr.com',
  'wss://nostr.zkid.social',
  'wss://relay.nostr.ro',
  'wss://nostr.bostonbtc.com',
  'wss://relay.cryptocculture.com',
  'wss://nostr.walletofsatoshi.com',
  'wss://nostr.mwmdev.com',
  'wss://nostr.bongbong.com',
  'wss://nostr.cro.social',
  'wss://relay.dwadziesciajeden.pl',
  'wss://knostr.neutrine.com',
  'wss://relay.kronkltd.net',
  'wss://nostr.radixrat.com',
  'wss://nostr3.actn.io',
  'wss://relay.orangepill.dev',
  'wss://relay.ryzizub.com',
  'wss://relay.honk.pw',
  'wss://puravida.nostr.land',
  'wss://nostr1.tunnelsats.com',
  'wss://nostr.hackerman.pro',
  'wss://nostr.sidnlabs.nl',
  'wss://zur.nostr.sx',
  'wss://nostr.f44.dev',
  'wss://nostr-verified.wellorder.net',
  'wss://nostr-relay.digitalmob.ro',
  'wss://nostr-verif.slothy.win',
  'wss://relay.1bps.io',
  'wss://nostr.easydns.ca',
  'wss://relay.nostriches.org',
  'wss://relay.nostr.africa',
  'wss://nostr-relay.nokotaro.com',
  'wss://nostr-bg01.ciph.rs',
  'wss://blg.nostr.sx',
  'wss://nostr.shmueli.org',
  'wss://no.str.watch',
  'wss://nostr.sg',
  'wss://nostr2.actn.io',
  'wss://relay.nostrzoo.com',
  'wss://nostr.pleb.network',
  'wss://nostr.mustardnodes.com',
  'wss://nostr.nodeofsven.com',
  'wss://relay.nostr.vision',
  'wss://nostr.zoomout.chat',
  'wss://spore.ws',
  'wss://nostrich.friendship.tw',
  'wss://nostr.bitcoin.sex',
  'wss://cloudnull.land',
  'wss://nostr.beta3.dev',
  'wss://btc.klendazu.com',
  'wss://nostr.ethtozero.fr',
  'wss://nostr.kollider.xyz',
  'wss://nostr.milou.lol',
  'wss://nostr.sandwich.farm',
  'wss://nostr.blocs.fr',
  'wss://nostr.adpo.co',
  'wss://nostr.8e23.net',
  'wss://nostr.developer.li',
  'wss://nostr.zxcvbn.space',
  'wss://relay.nostr-latam.link',
  'wss://relay.n057r.club',
  'wss://nostr.whoop.ph',
  'wss://paid.spore.ws',
  'wss://relay.nostrati.com',
  'wss://relay.nostr.au',
  'wss://nostr-01.dorafactory.org',
  'wss://global-relay.cesc.trade',
  'wss://relay.nostr.info',
  'wss://nostr.decentony.com',
  'wss://public.nostr.swissrouting.com',
  'wss://nostr.jimc.me',
  'wss://nostr.btcmp.com',
  'wss://nostr.actn.io',
  'wss://nostr.noones.com',
  'wss://nostr.drss.io',
  'wss://nostr.lnprivate.network',
  'wss://nostr.fmt.wiz.biz',
  'wss://nostr.thesimplekid.com',
  'wss://relay.nostr.com.au',
  'wss://bitcoinmaximalists.online',
  'wss://nostr.coinos.io',
  'wss://nostr.fediverse.jp',
  'wss://rsslay.nostr.moe',
  'wss://private.red.gb.net',
  'wss://nostr.bitcoinplebs.de',
  'wss://nostr.gromeul.eu',
  'wss://paid.no.str.cr',
  'wss://at.nostrworks.com',
  'wss://relay.stoner.com',
  'wss://relay.nostr.moe',
  'wss://nostr.ownscale.org',
  'wss://relay.nostr.nu',
  'wss://nostr.blockchaincaffe.it',
  'wss://relay.nvote.co',
  'wss://nostr.corebreach.com',
  'wss://nostr.hugo.md',
  'wss://nostr.1f52b.xyz',
  'wss://nostr-relay.bitcoin.ninja',
  'wss://nostr.terminus.money',
  'wss://nostr.sebastix.dev',
  'wss://nostr.coollamer.com',
  'wss://relay.nostr.jhot.me',
  'wss://private-nostr.v0l.io',
  'wss://nostr-pub.semisol.dev',
  'wss://relay.beta.fogtype.com',
  // Additional well-known relays not in the delete.nostr.com list
  'wss://relay.nostr.wirednet.jp',
  'wss://nostr-01.yakihonne.com',
  'wss://relay.getalby.com/v1',
  'wss://nostr.zebedee.cloud',
  'wss://relay.nos.social',
  'wss://relay.nostr.ch',
];

/** Configuration */
const BATCH_SIZE = 20;
const RELAY_TIMEOUT_MS = 5000;

export class BroadcastDeleteService {
  private static instance: BroadcastDeleteService;
  private systemLogger: SystemLogger;

  private constructor() {
    this.systemLogger = SystemLogger.getInstance();
  }

  static getInstance(): BroadcastDeleteService {
    if (!BroadcastDeleteService.instance) {
      BroadcastDeleteService.instance = new BroadcastDeleteService();
    }
    return BroadcastDeleteService.instance;
  }

  /**
   * Broadcast a signed deletion event to 150+ relays in the background.
   * Fire-and-forget — never throws, never blocks.
   */
  broadcastInBackground(signedEvent: SignedNostrEvent): void {
    // Fully async, no await — runs detached from caller
    this.doBroadcast(signedEvent).catch(error => {
      this.systemLogger.error('BroadcastDelete', `Unexpected error: ${error}`);
    });
  }

  /**
   * Main broadcast logic
   */
  private async doBroadcast(signedEvent: SignedNostrEvent): Promise<void> {
    // Build full relay set: hardcoded + aggregator relays from config
    const relayConfig = RelayConfig.getInstance();
    const fullRelaySet = new Set(BROADCAST_RELAYS);
    for (const relay of relayConfig.getAggregatorRelays()) {
      fullRelaySet.add(relay);
    }

    // Remove user's own relays (already handled by DeletionService)
    const ownRelays = new Set(
      relayConfig
        .getAllRelays()
        .filter(r => r.isActive)
        .map(r => r.url)
    );
    const broadcastRelays = [...fullRelaySet].filter(r => !ownRelays.has(r));

    if (broadcastRelays.length === 0) {
      this.systemLogger.info('BroadcastDelete', 'No additional relays to broadcast to');
      return;
    }

    this.systemLogger.info(
      'BroadcastDelete',
      `Broadcasting deletion to ${broadcastRelays.length} relays...`
    );

    // Broadcast in batches
    let successCount = 0;
    let failCount = 0;

    const batches = this.chunkArray(broadcastRelays, BATCH_SIZE);

    for (const batch of batches) {
      const results = await Promise.allSettled(
        batch.map(relay => this.publishToRelay(relay, signedEvent))
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          successCount++;
        } else {
          failCount++;
        }
      }
    }

    // Log final result
    this.systemLogger.info(
      'BroadcastDelete',
      `Broadcast complete: ${successCount} accepted, ${failCount} not found on relay`
    );
  }

  /**
   * Publish event to a single relay via raw WebSocket.
   * Returns true on OK, false on error/timeout — never throws.
   */
  private publishToRelay(relayUrl: string, event: SignedNostrEvent): Promise<boolean> {
    return new Promise(resolve => {
      let settled = false;

      const finish = (success: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch { /* ignore */ }
        resolve(success);
      };

      const timer = setTimeout(() => finish(false), RELAY_TIMEOUT_MS);

      let ws: WebSocket;
      try {
        ws = new WebSocket(relayUrl);
      } catch {
        finish(false);
        return;
      }

      ws.onopen = () => {
        try {
          ws.send(JSON.stringify(['EVENT', event]));
        } catch {
          finish(false);
        }
      };

      ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          // NIP-20: ["OK", <event_id>, <true|false>, <message>]
          if (data[0] === 'OK' && data[1] === event.id) {
            finish(data[2] === true);
          }
        } catch {
          // Ignore parse errors (NOTICE, EOSE, etc.)
        }
      };

      ws.onerror = () => finish(false);
    });
  }

  /**
   * Split array into chunks of given size
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}
