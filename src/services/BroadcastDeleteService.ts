/**
 * BroadcastDeleteService — Background broadcast of NIP-09 deletion events
 *
 * After the normal delete (to user's own relays), this service broadcasts
 * the signed Kind-5 event to 1400+ known relays in the background.
 *
 * Relay source: Hardcoded list of known public relays (merged from multiple sources).
 * WebSockets have no CORS restrictions, so this works from any origin.
 *
 * Reliability: each job is PERSISTED to IndexedDB (DeleteBroadcastStore) before
 * the first send, so it survives reload / app-quit / navigation and resumes on
 * the next launch and whenever the app/network comes back. Relays that don't
 * answer are retried with per-relay backoff until delivered or the 48h TTL.
 * Politeness: bounded global concurrency + at most one connection per host at a
 * time. Once the request reaches a relay, whether it honors it is not our concern.
 * Fire-and-forget from the caller's view — never throws, never blocks the UI.
 */

import { SystemLogger } from './SystemLogger';
import { RelayConfig } from './RelayConfig';
import { diagLog } from './DiagnosticLogger';
import { TypedEventBus } from '../core/TypedEventBus';
import {
  DeleteBroadcastStore,
  type BroadcastJob,
  type StoredSignedEvent,
} from './DeleteBroadcastStore';

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
  'wss://relay.ditto.pub',
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
  'wss://nostr-01.yakihonne.com',
  'wss://relay.getalby.com/v1',
  'wss://nostr.zebedee.cloud',
  'wss://relay.nos.social',
  'wss://relay.nostr.ch',
  // High user-count relays from the Relay Distribution ranking (2026-06-11).
  // relay.damus.io is included here as a deliberate exception: it's not a
  // shipped default, but a NIP-09 delete should still reach it.
  'wss://relay.damus.io',
  'wss://relay.shitforce.one',
  'wss://relay.momostr.pink',
  'wss://nostr.coinfundit.com',
  'wss://nostr-us.coinfundit.com',
  'wss://ditto.pub/relay',
  'wss://relay.hodl.ar',
  'wss://relay.siamstr.com',
  'wss://nostr.coinfund.app',
  'wss://nostr.zbd.gg',
  'wss://relay.fountain.fm',
  'wss://relay.plebstr.com',
  'wss://sendit.nosflare.com',
  'wss://nostrelites.org',
  'wss://nostr.sprovoost.nl',
  'wss://nostr.land',
  'wss://wot.nostr.net',
  'wss://nostr.lol',
  'wss://relay.wavlake.com',
  'wss://relay.mutinywallet.com',
  'wss://relay.0xchat.com',
  'wss://wot.utxo.one',
  'wss://pyramid.fiatjaf.com',
  'wss://yabu.me',
  'wss://wot.nostr.party',
  'wss://ephemerelay.mostr.pub',
  // Live relays from relay-liveness monitoring (nostr.watch dataset),
  // harvested 2026-06-11 — currently-online relays for maximum delete reach.
  'wss://0x-nostr-relay.fly.dev',
  'wss://1.dreamcloud.darkbytelabs.com/nostr',
  'wss://140.f7z.io',
  'wss://757btc.app/nostrclient/api/v1/relay',
  'wss://9yo.punipoka.pink',
  'wss://adre.su',
  'wss://adre.su/tango',
  'wss://aegis.relayted.de',
  'wss://aeon.libretechsystems.xyz',
  'wss://aggr.nostr.land',
  'wss://airchat.nostr1.com',
  'wss://alink.nostr1.com',
  'wss://amb-relay.edufeed.org',
  'wss://anon.computer',
  'wss://antiprimal.net',
  'wss://aplaceinthesun.nostr1.com',
  'wss://aquaticchickentheory.nostr1.com',
  'wss://aquaticchickentheory.nostr1.com/jade-warden',
  'wss://armada.sharegap.net',
  'wss://articles.layer3.news',
  'wss://asia.azzamo.net',
  'wss://asia.vectorapp.io/nostr',
  'wss://assistantrelay.rodbishop.nz',
  'wss://atlas.nostr.land',
  'wss://auth.nostr1.com',
  'wss://backup.keychat.io',
  'wss://bagus.my/nostrrelay/0',
  'wss://barcelona.bitcoinwalk.org',
  'wss://barcelona.bitcoinwalk.org/xenon-hotel',
  'wss://basspistol.org',
  'wss://basspistol.org/favorites',
  'wss://basspistol.org/inbox',
  'wss://basspistol.org/internal',
  'wss://basspistol.org/popular',
  'wss://basspistol.org/uppermost',
  'wss://bcast.girino.org',
  'wss://bcast.seutoba.com.br',
  'wss://bcast.seutoba.com.br/hotel',
  'wss://bcast.seutoba.com.br/onyx',
  'wss://beeswax.hivetalk.org',
  'wss://beeswax.hivetalk.org/echo',
  'wss://bitchat.nostr1.com',
  'wss://bitchat.nostr1.com/ivory-prism',
  'wss://bitchat.nostr1.com/warden',
  'wss://bitcoiner.social',
  'wss://bitcoiner.social/haven',
  'wss://bitcoiner.social/lantern-karma',
  'wss://bitcoiner.social/victor',
  'wss://bitcoinmajlis.nostr1.com',
  'wss://bitcoinmajlis.nostr1.com/haven',
  'wss://bitcoinmajlis.nostr1.com/papa-nexus',
  'wss://bitcoinmajlis.nostr1.com/whiskey-lantern',
  'wss://bitcoinmajlis.nostr1.com/yankee-lima-zenith',
  'wss://bitcoinostr.duckdns.org',
  'wss://bitstack.app',
  'wss://blossom.gnostr.cloud',
  'wss://blossom.sectiontwo.org',
  'wss://boadee.babystepsbtc.com',
  'wss://boadee.babystepsbtc.com/hotel-hotel-nexus',
  'wss://boadee.babystepsbtc.com/kilo-warden-raven',
  'wss://bobbb.duckdns.org',
  'wss://bookmarks.relays.land',
  'wss://bostr.erechorse.com',
  'wss://bostr.online',
  'wss://bots.utxo.one',
  'wss://brainstorm.world/relay',
  'wss://bridge.tagomago.me',
  'wss://bucket.coracle.social',
  'wss://budabit.nostr1.com',
  'wss://budabit.nostr1.com/marble-anchor',
  'wss://budabit.nostr1.com/uniform',
  'wss://bunker.vanderwarker.family',
  'wss://cachapa.cc',
  'wss://cache.trustr.ing',
  'wss://cache1.primal.net/v1',
  'wss://cache2.primal.net/v1',
  'wss://cagliostr.compile-error.net',
  'wss://carlos-cdb.top',
  'wss://cellar.nostr.wine',
  'wss://cfrelay.haorendashu.workers.dev',
  'wss://cfrelay.haorendashutest.workers.dev',
  'wss://cfrelay.haorendashutest.workers.dev/zenith-haven-haven',
  'wss://cfrelay.puhcho.workers.dev',
  'wss://cfrelay.royalgarter.workers.dev',
  'wss://cfrelay.snowcait.workers.dev',
  'wss://chadf.nostr1.com',
  'wss://chadf.nostr1.com/golf',
  'wss://chat-relay.zap-work.com',
  'wss://chat.bitcoinwalk.org',
  'wss://chat.bitcoinwalk.org/tango-zulu',
  'wss://chat.boom.money',
  'wss://chat.shakespeare.diy',
  'wss://chillstr.nostr1.com',
  'wss://chillstr.nostr1.com/jade-ivory-uniform',
  'wss://chillstr.nostr1.com/sierra-charlie',
  'wss://chillstr.nostr1.com/zulu-raven',
  'wss://chorus.almostmachines.dev',
  'wss://chorus.almostmachines.dev/cipher-juliet',
  'wss://chorus.almostmachines.dev/romeo-cipher',
  'wss://chorus.bonsai.com',
  'wss://chorus.mikedilger.com:444',
  'wss://chorus.pjv.me',
  'wss://chorus.tealeaf.dev',
  'wss://christpill.nostr1.com',
  'wss://christpill.nostr1.com/ember-nexus',
  'wss://christpill.nostr1.com/raven-jade-flint',
  'wss://chronicle.dtonon.com',
  'wss://ciao.rinbal.de',
  'wss://cobrafuma.com/relay',
  'wss://communities.nos.social',
  'wss://comrelay.nostrdvm.com',
  'wss://comrelay.nostrdvm.com/titan',
  'wss://cr.zap.watch',
  'wss://cr.zap.watch/uniform',
  'wss://creatr.nostr.wine',
  'wss://cs-relay.nostrdev.com',
  'wss://cs-relay.nostrdev.com/charlie',
  'wss://custom.fiatjaf.com',
  'wss://cyberspace.nostr1.com',
  'wss://cyberspace.nostr1.com/anchor-marble',
  'wss://cyberspace.nostr1.com/bravo',
  'wss://cyberspace.nostr1.com/jade-zenith',
  'wss://czas.plus',
  'wss://czas.top',
  'wss://czas.top/nexus-karma',
  'wss://czas.top/sierra',
  'wss://data.relay.vanderwarker.family',
  'wss://david.nostr1.com',
  'wss://de.zap.watch',
  'wss://dev-nostr.bityacht.io',
  'wss://dev-nostr.bityacht.io/juliet',
  'wss://dev-nostr.bityacht.io/november-quebec-yonder',
  'wss://dev.calendar-relay.edufeed.org',
  'wss://dev.calendar-relay.edufeed.org/charlie-raven-dynamo',
  'wss://dev.calendar-relay.edufeed.org/ember-marble',
  'wss://dev.relay.edufeed.org',
  'wss://dev.relay.stream',
  'wss://directory.yabu.me',
  'wss://discovery.eu.nostria.app',
  'wss://discovery.eu.nostria.app/uniform-anchor',
  'wss://discovery.us.nostria.app',
  'wss://ditto.slothy.win/relay',
  'wss://dkkc.nostr1.com',
  'wss://dm-test-nostr-rs-42-disabled.samt.st',
  'wss://dm-test-nostr-rs-42-enabled.samt.st',
  'wss://dm-test-strfry-generic.samt.st',
  'wss://dm.scuba323.com',
  'wss://dm.scuba323.com/lima-yankee',
  'wss://drops.basspistol.org',
  'wss://drops.basspistol.org/cipher',
  'wss://drops.basspistol.org/tango',
  'wss://dumpster02.nostr1.com/kilo-victor',
  'wss://dumpster02.nostr1.com/papa',
  'wss://dwebcamp.nos.social',
  'wss://eden.nostr.land/invoices',
  'wss://eden.nostr.land/invoices/anchor',
  'wss://eden.nostr.land/invoices/xray-onyx-bravo',
  'wss://eostagram.com',
  'wss://ephemeral.snowflare.cc',
  'wss://es.zap.watch',
  'wss://espelho.girino.org',
  'wss://eu.nostr.pikachat.org',
  'wss://fabian.nostr1.com',
  'wss://fanfares.nostr1.com',
  'wss://feedback.relays.land',
  'wss://feeds.nostrarchives.com/users/upandcoming',
  'wss://fiatjaf.com',
  'wss://fido-news.z7.ai',
  'wss://filter.nostr.wine',
  'wss://flash.eurostr.eu',
  'wss://freelay.sovbit.host',
  'wss://frens.nostr1.com',
  'wss://frjosh.nostr1.com',
  'wss://ftp.halifax.rwth-aachen.de/nostr',
  'wss://futarchyhub.com/relay',
  'wss://git.shakespeare.diy',
  'wss://git.shakespeare.diy/charlie-lima',
  'wss://gitnostr.com',
  'wss://gitnostr.com/karma-cipher',
  'wss://gnostr.com',
  'wss://goodinter.net',
  'wss://goskatespots.nostr1.com',
  'wss://greensoul.space',
  'wss://groups.0xchat.com',
  'wss://groups.0xchat.com/golf-mike-quartz',
  'wss://groups.fiatjaf.com',
  'wss://groups.fiatjaf.com/flint-papa-mike',
  'wss://groups.fiatjaf.com/india-onyx-november',
  'wss://groups.hzrd149.com',
  'wss://groups.hzrd149.com/romeo-dynamo-romeo',
  'wss://groups.hzrd149.com/vertex-glyph',
  'wss://groups.hzrd149.com/whiskey-tango-bravo',
  'wss://groups.satsdisco.com',
  'wss://groups.satsdisco.com/bravo-zenith',
  'wss://groups.yugoatobe.com',
  'wss://h.600.wtf',
  'wss://h.codingarena.top',
  'wss://h.codingarena.top/chat',
  'wss://h.codingarena.top/inbox',
  'wss://haven.aaro.cc',
  'wss://haven.aaro.cc/inbox',
  'wss://haven.almostmachines.dev/inbox',
  'wss://haven.almostmachines.dev/outbox',
  'wss://haven.almostmachines.dev/outbox/raven-flint-anchor',
  'wss://haven.calva.dev',
  'wss://haven.calva.dev/chat',
  'wss://haven.calva.dev/golf',
  'wss://haven.calva.dev/lantern',
  'wss://haven.danconwaydev.com',
  'wss://haven.danconwaydev.com/inbox',
  'wss://haven.danconwaydev.com/sierra-zenith-delta',
  'wss://haven.danconwaydev.com/titan-titan-victor',
  'wss://haven.dergigi.com',
  'wss://haven.dergigi.com/inbox',
  'wss://haven.dergigi.com/lantern-uniform-victor',
  'wss://haven.downisontheup.ca',
  'wss://haven.downisontheup.ca/inbox',
  'wss://haven.girino.org',
  'wss://haven.jonmartins.com/outbox',
  'wss://haven.laoc.xyz',
  'wss://haven.laoc.xyz/zulu',
  'wss://haven.nostrfreedom.net',
  'wss://haven.nostrfreedom.net/inbox',
  'wss://haven.nostrfreedom.net/inbox/titan',
  'wss://haven.nostrfreedom.net/inbox/titan-umbra',
  'wss://haven.nostrfreedom.net/inbox/xray-titan-xray',
  'wss://haven.nostrfreedom.net/jade-xray',
  'wss://haven.nostrfreedom.net/raven-victor-haven',
  'wss://haven.nostrsec.net',
  'wss://haven.obscureindex.com',
  'wss://haven.obscureindex.com/delta-lima',
  'wss://haven.relayted.de',
  'wss://haven.ronniesamuel.com',
  'wss://haven.ronniesamuel.com/inbox',
  'wss://haven.slidestr.net',
  'wss://haven.slidestr.net/inbox',
  'wss://haven.sovereignengineering.io/outbox',
  'wss://haven.superfriends.online',
  'wss://haven.superfriends.online/inbox',
  'wss://haven.tealeaf.dev',
  'wss://haven.tealeaf.dev/inbox',
  'wss://haven2.girino.org/inbox',
  'wss://haven2.girino.org/outbox',
  'wss://hbr.coracle.social',
  'wss://hbr.coracle.social/chat',
  'wss://hbr.coracle.social/chat/nexus-india',
  'wss://hbr.coracle.social/chat/quartz-jade-lantern',
  'wss://henhouse.social/relay',
  'wss://herbstmeister.com',
  'wss://herbstmeister.com/inbox',
  'wss://hist.nostr.land',
  'wss://hodlbod.coracle.social',
  'wss://hol.is',
  'wss://hole.v0l.io',
  'wss://holyfit.scuba323.com/relay',
  'wss://home.buildingtheneighbourhood.org',
  'wss://hornetstorage.net/relay',
  'wss://hotrightnow.nostr1.com',
  'wss://hsuite-nostr-relay.hbarsuite.workers.dev',
  'wss://imp.relays.land',
  'wss://impromptu.relays.land',
  'wss://inbox.azzamo.net',
  'wss://inbox.azzamo.net/ember-dynamo-onyx',
  'wss://inbox.azzamo.net/zulu',
  'wss://inbox.mycelium.social/india-foxtrot',
  'wss://inbox.nostr.wine',
  'wss://inbox.relays.land',
  'wss://inbox.scuba323.com/cipher-echo-romeo',
  'wss://indexer.coracle.social',
  'wss://indexer.coracle.social/umbra-xenon',
  'wss://inner.sebastix.social',
  'wss://insta-relay.apps3.slidestr.net',
  'wss://internal.coracle.social',
  'wss://invillage-outvillage.com',
  'wss://ithurtswhenip.ee',
  'wss://jaunters.basspistol.org',
  'wss://jaunters.basspistol.org/flint',
  'wss://jaunters.basspistol.org/inbox',
  'wss://jaunters.basspistol.org/ivory-victor-dynamo',
  'wss://jaunters.basspistol.org/outbox',
  'wss://jaunters.basspistol.org/outbox/vertex-sable-yonder',
  'wss://jaunters.basspistol.org/prism-onyx',
  'wss://jingle.carlos-cdb.top',
  'wss://kanagrovv.kozow.com',
  'wss://kasztanowa.bieda.it',
  'wss://kasztanowa.bieda.it/internal',
  'wss://kevinwilliam.nostr1.com',
  'wss://khatru.nostrver.se',
  'wss://kiir.us',
  'wss://kiwibuilders.nostr21.net',
  'wss://kiwibuilders.nostr21.net/zenith',
  'wss://knostr.neutrine.com/lantern-haven-kilo',
  'wss://koru.bitcointxoko.org',
  'wss://kotukonostr.onrender.com',
  'wss://kraftig.nostr1.com',
  'wss://lang.relays.land/id',
  'wss://lang.relays.land/la',
  'wss://lang.relays.land/ru',
  'wss://lang.relays.land/zh',
  'wss://leeten.basspistol.org',
  'wss://leeten.basspistol.org/inbox',
  'wss://leeten.basspistol.org/inbox/beacon',
  'wss://lnb.bolverker.com/nostrrelay/666',
  'wss://lnb.bolverker.com/nostrrelay/b07d5967-b20a-4e83-a713-8bbea0694660',
  'wss://lnbits.mcld.eu/nostrrelay/test',
  'wss://lnbits.moizen.xyz/nostrrelay/moizen',
  'wss://lnbits.sgn.space/nostrclient/api/v1/relay',
  'wss://lockbox.relays.land',
  'wss://loli.church',
  'wss://loli.church/marble-quartz-hotel',
  'wss://lolicon.monster',
  'wss://lunchbox.sandwich.farm',
  'wss://mastodon.cloud/api/v1/streaming/vertex-lantern',
  'wss://media.bujac.pl',
  'wss://media.bujac.pl/echo-victor-titan',
  'wss://merrcurrup.railway.app',
  'wss://meta.bitcoinwalk.org',
  'wss://meta.bitcoinwalk.org/dynamo-mike',
  'wss://meta.spaces.coracle.social',
  'wss://meta.spaces.coracle.social/bravo',
  'wss://meta.spaces.coracle.social/kilo-flint-alpha',
  'wss://mihhdu.org/nostr',
  'wss://mine.yard-news.xyz',
  'wss://misskey.04.si',
  'wss://misskey.art',
  'wss://misskey.art/zulu-victor-uniform',
  'wss://misskey.cloud',
  'wss://misskey.cloud/delta-xray-xenon',
  'wss://misskey.cloud/oscar-foxtrot-ivory',
  'wss://misskey.design',
  'wss://misskey.gothloli.club',
  'wss://misskey.io',
  'wss://misskey.social',
  'wss://misskey.systems',
  'wss://misskey.systems/flint-umbra',
  'wss://misskey.takehi.to',
  'wss://misskey.yukineko.me',
  'wss://mls.akdeniz.edu.tr/nostr',
  'wss://monitorlizard.nostr1.com',
  'wss://monitorlizard.nostr1.com/juliet-ember-nexus',
  'wss://multiplexer.huszonegy.world',
  'wss://multiplexer.huszonegy.world/anchor',
  'wss://multiplexer.huszonegy.world/charlie-xray-papa',
  'wss://muxstr.northwest.io',
  'wss://muxstr.northwest.io/ivory-november-juliet',
  'wss://muxstr.northwest.io/zenith',
  'wss://myvoiceourstory.org',
  'wss://myvoiceourstory.org/internal',
  'wss://myvoiceourstory.org/personal',
  'wss://n.ka.st',
  'wss://namgoongjiwoo.nostr1.com',
  'wss://namgoongjiwoo.nostr1.com/mike',
  'wss://nerostr.xmr.rocks',
  'wss://nestr.nedao.ch',
  'wss://nestr.nedao.ch/inbox',
  'wss://nestr.nedao.ch/internal',
  'wss://news-zh-node2.relay.stream',
  'wss://news.utxo.one',
  'wss://news.yard-news.xyz',
  'wss://next.nsite.run',
  'wss://nexus.libernet.app',
  'wss://nfdb.noswhere.com',
  'wss://nfrelay.app',
  'wss://ngit.danconwaydev.com',
  'wss://nip13.girino.org',
  'wss://nip17.com',
  'wss://nip17.com/vertex-marble-romeo',
  'wss://nip17.tomdwyer.uk/warden',
  'wss://nip29-relay.compile-error.net',
  'wss://nip85.brainstorm.world',
  'wss://nip85.nostr.band',
  'wss://nip85.nostr1.com',
  'wss://nip85.nostr1.com/beacon-victor-quebec',
  'wss://nittom.nostr1.com',
  'wss://njump.me',
  'wss://noornode.nostr1.com',
  'wss://nortis.nostr1.com',
  'wss://nos.xmark.cc',
  'wss://nos.zct-mrl.com',
  'wss://nost.xp.dog',
  'wss://nostr-01.uid.ovh',
  'wss://nostr-02.yakihonne.com',
  'wss://nostr-1.nbo.angani.co/marble',
  'wss://nostr-2.21crypto.ch',
  'wss://nostr-check.me',
  'wss://nostr-dev.azuki.blue',
  'wss://nostr-dev.wellorder.net',
  'wss://nostr-kyomu-haskell.onrender.com',
  'wss://nostr-pr02.redscrypt.org',
  'wss://nostr-pr04.redscrypt.org',
  'wss://nostr-privrelay.mamemo.online',
  'wss://nostr-relay-1.trustlessenterprise.com',
  'wss://nostr-relay.algotech.io',
  'wss://nostr-relay.amethyst.name',
  'wss://nostr-relay.amethyst.name/golf-glyph-xenon',
  'wss://nostr-relay.cbrx.io',
  'wss://nostr-relay.corb.net',
  'wss://nostr-relay.derekross.me',
  'wss://nostr-relay.derekross.me/chat',
  'wss://nostr-relay.derekross.me/chat/sierra-quartz-alpha',
  'wss://nostr-relay.derekross.me/inbox',
  'wss://nostr-relay.derekross.me/nexus-karma-bravo',
  'wss://nostr-relay.dont-panic.dev',
  'wss://nostr-relay.irgenius.org',
  'wss://nostr-relay.moctane.net',
  'wss://nostr-relay.moe.gift',
  'wss://nostr-relay.nextblockvending.com',
  'wss://nostr-relay.psfoundation.info',
  'wss://nostr-relay.schnitzel.world',
  'wss://nostr-relay.schnitzel.world/onyx',
  'wss://nostr-relay.sn-media.com',
  'wss://nostr-rs-relay-ishosta.phamthanh.me',
  'wss://nostr-rs-relay-qj1h.onrender.com',
  'wss://nostr-rs-relay.dev.fedibtc.com',
  'wss://nostr.001.j5s9.dev',
  'wss://nostr.0x7e.xyz',
  'wss://nostr.1312.media',
  'wss://nostr.1sat.org',
  'wss://nostr.21crypto.ch',
  'wss://nostr.21mio.space',
  'wss://nostr.256k1.dev',
  'wss://nostr.2b9t.xyz',
  'wss://nostr.2h2o.io',
  'wss://nostr.438b.net',
  'wss://nostr.4rs.nl',
  'wss://nostr.8777.ch',
  'wss://nostr.88mph.life',
  'wss://nostr.ac/cipher',
  'wss://nostr.agentcampfire.com',
  'wss://nostr.alexanarcho.live',
  'wss://nostr.anhkagi.net',
  'wss://nostr.app.runonflux.io',
  'wss://nostr.aruku.ovh',
  'wss://nostr.asdf.mx',
  'wss://nostr.azuki.blue',
  'wss://nostr.azzamo.net',
  'wss://nostr.babyshark.win',
  'wss://nostr.bgbitcoin.club',
  'wss://nostr.bit4use.com',
  'wss://nostr.bitcoiner.social/romeo',
  'wss://nostr.bitcoinist.org',
  'wss://nostr.bitcoinplebs.de/vertex-whiskey-ivory',
  'wss://nostr.bitcoinx.gr',
  'wss://nostr.bitpunk.fm',
  'wss://nostr.biu.im',
  'wss://nostr.blankfors.se',
  'wss://nostr.bond',
  'wss://nostr.btcforgens.com',
  'wss://nostr.caramboo.com',
  'wss://nostr.carloslugones.com',
  'wss://nostr.carloslugones.com/papa-foxtrot-charlie',
  'wss://nostr.carroarmato0.be',
  'wss://nostr.carroarmato0.be/beacon',
  'wss://nostr.ch3n2k.com',
  'wss://nostr.chaima.info',
  'wss://nostr.choe.kr',
  'wss://nostr.cizmar.net',
  'wss://nostr.cloud.vinney.xyz',
  'wss://nostr.cltrrd.us',
  'wss://nostr.codonaft.com',
  'wss://nostr.compile-error.net',
  'wss://nostr.computingcache.com',
  'wss://nostr.cypherpunk.today',
  'wss://nostr.czas.plus',
  'wss://nostr.d11n.net',
  'wss://nostr.d11n.net/inbox',
  'wss://nostr.d11n.net/outbox',
  'wss://nostr.damupi.com/inbox',
  'wss://nostr.damupi.com/outbox',
  'wss://nostr.dbtc.link',
  'wss://nostr.defencegeeks.net',
  'wss://nostr.derogab.com',
  'wss://nostr.dlcdevkit.com',
  'wss://nostr.dler.com',
  'wss://nostr.dontyou.click',
  'wss://nostr.dpinkerton.com',
  'wss://nostr.easycryptosend.it',
  'wss://nostr.extrabits.io',
  'wss://nostr.faultables.net',
  'wss://nostr.frostr.xyz',
  'wss://nostr.girino.org',
  'wss://nostr.gravitywell.xyz',
  'wss://nostr.grooveix.com',
  'wss://nostr.hashi.sbs',
  'wss://nostr.heavyrubberslave.com',
  'wss://nostr.hekster.org',
  'wss://nostr.hifish.org',
  'wss://nostr.hiperbolajanus.com',
  'wss://nostr.hoppe-relay.it.com',
  'wss://nostr.huszonegy.world',
  'wss://nostr.ides.club',
  'wss://nostr.ingwie.me',
  'wss://nostr.intrepid18.com',
  'wss://nostr.islandarea.net',
  'wss://nostr.janx.com',
  'wss://nostr.jcloud.es',
  'wss://nostr.jcloud.es/oscar',
  'wss://nostr.jonmartins.com',
  'wss://nostr.jonmartins.com/inbox',
  'wss://nostr.kaputtgart.social',
  'wss://nostr.kfx.fr',
  'wss://nostr.kfx.fr/inbox',
  'wss://nostr.koning-degraaf.nl',
  'wss://nostr.koning-degraaf.nl/foxtrot-glyph',
  'wss://nostr.kosmos.org',
  'wss://nostr.l00p.org',
  'wss://nostr.l484.com',
  'wss://nostr.l484.com/lima-ivory',
  'wss://nostr.liberty.fans',
  'wss://nostr.lifelog.be',
  'wss://nostr.lifelog.be/inbox',
  'wss://nostr.lopp.social',
  'wss://nostr.lopp.social/anchor-sable-hotel',
  'wss://nostr.lorentz.is',
  'wss://nostr.mad-social.net',
  'wss://nostr.mailbox.bz',
  'wss://nostr.mannuk.rocks/cipher-titan',
  'wss://nostr.me/relay',
  'wss://nostr.mineracks.com',
  'wss://nostr.mitchelltribe.com',
  'wss://nostr.mtrj.cz',
  'wss://nostr.myshosholoza.co.za',
  'wss://nostr.n7ekb.net',
  'wss://nostr.nadajnik.org',
  'wss://nostr.neilalexander.dev',
  'wss://nostr.night7.space',
  'wss://nostr.noderunners.network',
  'wss://nostr.nodesmap.com',
  'wss://nostr.nothing.is-lost.org',
  'wss://nostr.notribe.net',
  'wss://nostr.novacisko.cz',
  'wss://nostr.omniacollective.is/inbox',
  'wss://nostr.omniacollective.is/outbox',
  'wss://nostr.onbitcoinstandard.com',
  'wss://nostr.openhoofd.nl',
  'wss://nostr.overmind.lol',
  'wss://nostr.pareto.space',
  'wss://nostr.pbfs.io',
  'wss://nostr.petrkr.net/strfry',
  'wss://nostr.plantroon.com',
  'wss://nostr.polyserv.xyz',
  'wss://nostr.primz.org',
  'wss://nostr.prl.plus/quartz-uniform',
  'wss://nostr.prl.plus/warden-vertex-charlie',
  'wss://nostr.ps1829.com',
  'wss://nostr.psychoet.nexus',
  'wss://nostr.quali.chat',
  'wss://nostr.quantx.synology.me',
  'wss://nostr.rblb.it',
  'wss://nostr.reckless.dev',
  'wss://nostr.reelnetwork.eu',
  'wss://nostr.rikmeijer.nl',
  'wss://nostr.rtvslawenia.com',
  'wss://nostr.rubberdoll.cc',
  'wss://nostr.sathoarder.com',
  'wss://nostr.satoshi-mall.com',
  'wss://nostr.satoshisfrens.win',
  'wss://nostr.schneimi.de',
  'wss://nostr.se7enz.com',
  'wss://nostr.sectiontwo.org',
  'wss://nostr.self-determined.de',
  'wss://nostr.semisol.dev',
  'wss://nostr.sgiath.dev',
  'wss://nostr.sgn.space',
  'wss://nostr.sleepingcro.ws',
  'wss://nostr.slothy.win',
  'wss://nostr.snowbla.de',
  'wss://nostr.spaceshell.xyz',
  'wss://nostr.spicyz.io',
  'wss://nostr.stakey.net',
  'wss://nostr.sudocarlos.com',
  'wss://nostr.sudocarlos.com/inbox',
  'wss://nostr.sudocarlos.com/outbox',
  'wss://nostr.superfriends.online',
  'wss://nostr.t-rg.ws',
  'wss://nostr.tac.lol',
  'wss://nostr.tadryanom.me',
  'wss://nostr.tagomago.me',
  'wss://nostr.tbxnetworx.de',
  'wss://nostr.tegila.com.br',
  'wss://nostr.thalheim.io',
  'wss://nostr.thank.eu',
  'wss://nostr.thebiglake.org',
  'wss://nostr.thurk.org',
  'wss://nostr.timegate.co',
  'wss://nostr.tools.global.id',
  'wss://nostr.travisshears.com',
  'wss://nostr.twinkle.lol',
  'wss://nostr.typenull.net',
  'wss://nostr.ufm.lol',
  'wss://nostr.ufm.lol/kilo-romeo',
  'wss://nostr.ufm.lol/raven-karma-papa',
  'wss://nostr.ussenterprise.xyz',
  'wss://nostr.v6.army',
  'wss://nostr.vps.satsnode.xyz',
  'wss://nostr.wecsats.io',
  'wss://nostr.wild-vibes.ts.net',
  'wss://nostr.xmr.rocks',
  'wss://nostr01.counterclockwise.io',
  'wss://nostr1.bananabit.net',
  'wss://nostr2.girino.org',
  'wss://nostr2.thalheim.io',
  'wss://nostrcheck.me',
  'wss://nostrcity-club.fly.dev',
  'wss://nostream-production-643a.up.railway.app',
  'wss://nostream.macewan.nz',
  'wss://nostrel.fbarone.net',
  'wss://nostrelay.circum.space',
  'wss://nostrelay.yeghro.com',
  'wss://nostrich.zonemix.tech',
  'wss://nostriches.club',
  'wss://nostril.cam',
  'wss://nostrja-kari-nip50.heguro.com',
  'wss://nostrja-kari.heguro.com',
  'wss://nostrrelay.com',
  'wss://nostrrelay.taylorperron.com',
  'wss://nostrrelay.win',
  'wss://nostrride.io',
  'wss://nostrsgp.notribe.net',
  'wss://nostrum.satoshinakamoto.win',
  'wss://notemine.io',
  'wss://notes.miguelalmodo.pr',
  'wss://notify.damus.io',
  'wss://novoa.nagoya',
  'wss://nr.rosano.ca',
  'wss://nr1.breez.technology',
  'wss://nrelay.c-stellar.net',
  'wss://nrelay.helche.cc',
  'wss://nrelay.pubnostr.com',
  'wss://nrelay.xyz',
  'wss://nrs-01.darkcloudarcade.com',
  'wss://nrs-02.darkcloudarcade.com',
  'wss://nsite.run',
  'wss://nstr.utn.lol',
  'wss://nunlock.scuba323.com/relay',
  'wss://nwc.nostr1.com',
  'wss://nwc.primal.net',
  'wss://nwc.primal.net/7kk2lhwkqyb8j2uishfhat6zgpsjcr',
  'wss://nwc.primal.net/ayvjleilmx0al7j2pqt24qed1z7a8s',
  'wss://nwc.primal.net/bnlzbi797yvid3vhz4boh3bd2f2lj3',
  'wss://nwc.primal.net/c4ib8h2rs62bkmlk4wu7jbko9ugqbn',
  'wss://nwc.primal.net/jcnbbw6lmdr6qsslkw9hq1hv4xlh44',
  'wss://nwc.primal.net/puefmy6z9crtpk87spyz7p9hf4m1wk',
  'wss://nwc.primal.net/tfcowz9lq5r31cc0f6b5d7uqf90ggg',
  'wss://nwc.primal.net/uintxl3kwpmcqmpb95nqwzmk3qdko9',
  'wss://nwc.scuba323.com',
  'wss://nwc.scuba323.com/nexus-whiskey-anchor',
  'wss://nwc.scuba323.com/onyx-golf',
  'wss://nwclay.paywithflash.com/pos',
  'wss://okn.czas.plus',
  'wss://ol.spaces.coracle.social',
  'wss://orly-stil.edufeed.org',
  'wss://orly.edufeed.org',
  'wss://osmu.spaces.coracle.social',
  'wss://pantry.zap.cooking',
  'wss://pareto.nostr1.com',
  'wss://personal.relays.land',
  'wss://pickle.nostr1.com',
  'wss://plebchain.club',
  'wss://pnostr.self-determined.de',
  'wss://pnwbtc.spaces.coracle.social',
  'wss://podsystems.nostr1.com',
  'wss://podsystems.nostr1.com/quartz-titan',
  'wss://podtards.com',
  'wss://podtards.com/chat',
  'wss://portal-relay.pareto.space',
  'wss://pow.relays.land',
  'wss://powrelay.xyz',
  'wss://premis.one',
  'wss://premium.nostr.bar',
  'wss://premium.primal.net',
  'wss://premium.primal.net/titan',
  'wss://primus.nostr1.com',
  'wss://primus.nostr1.com/haven-jade-romeo',
  'wss://private.nostr.bar',
  'wss://prl.plus',
  'wss://problematic.network',
  'wss://profiles.nostr1.com',
  'wss://profiles.nostrver.se',
  'wss://profiles.nostrver.se/onyx-lantern-marble',
  'wss://profiles.nostrver.se/xenon-november',
  'wss://promenade.fiatjaf.com',
  'wss://promenade.fiatjaf.com/haven-lantern',
  'wss://public.crostr.com',
  'wss://public.plume.website',
  'wss://puravida.nostr.land/invoices',
  'wss://purplerelay.com',
  'wss://push.services.mozilla.com',
  'wss://pyramid.fiatjaf.com/inbox',
  'wss://pyramid.moseler.info/inbox',
  'wss://pyramid.self-determined.de',
  'wss://pyramid.self-determined.de/inbox',
  'wss://qubestr.zenon.red/glyph-dynamo-juliet',
  'wss://quietplace.xyz',
  'wss://r.0kb.io',
  'wss://r.alphaama.com',
  'wss://r.f7z.io',
  'wss://reedvpn.asuscomm.com',
  'wss://relay-can.zombi.cloudrodion.com',
  'wss://relay-dev.gulugulu.moe',
  'wss://relay-dev.satlantis.io',
  'wss://relay-fra.zombi.cloudrodion.com',
  'wss://relay-nostr.0xti.com',
  'wss://relay-nwc.rizful.com',
  'wss://relay-op.nostr1.com',
  'wss://relay-rpi.edufeed.org',
  'wss://relay-testnet.k8s.layer3.news',
  'wss://relay.1in7.com',
  'wss://relay.2020117.xyz',
  'wss://relay.21mil.me',
  'wss://relay.21mil.me/inbox',
  'wss://relay.235421.xyz',
  'wss://relay.398ja.xyz',
  'wss://relay.44billion.net',
  'wss://relay.757btc.org',
  'wss://relay.abvstudio.net',
  'wss://relay.agilesolutionlabs.com',
  'wss://relay.agora.social',
  'wss://relay.agorist.space',
  'wss://relay.albylabs.com',
  'wss://relay.alex71btc.com',
  'wss://relay.allsocial.me',
  'wss://relay.andotherstuff.org',
  'wss://relay.andotherstuff.org/charlie-prism-jade',
  'wss://relay.andotherstuff.org/golf',
  'wss://relay.angor.io',
  'wss://relay.anmore.me',
  'wss://relay.anzenkodo.workers.dev',
  'wss://relay.arcanican.is',
  'wss://relay.argw.com',
  'wss://relay.artio.inf.unibe.ch',
  'wss://relay.artiostr.ch',
  'wss://relay.artiostr.ch/foxtrot',
  'wss://relay.artx.market',
  'wss://relay.arx-ccn.com',
  'wss://relay.azzamo.net',
  'wss://relay.bankless.at',
  'wss://relay.bao.network',
  'wss://relay.basedboys.club',
  'wss://relay.basedboys.club/inbox',
  'wss://relay.bebond.net',
  'wss://relay.beginningend.com',
  'wss://relay.benthecarman.com',
  'wss://relay.bikel.ink/marble',
  'wss://relay.binaryrobot.com',
  'wss://relay.bitcoincafe.de',
  'wss://relay.bitcoindistrict.org',
  'wss://relay.bitcoindistrict.org/ivory-yankee',
  'wss://relay.bitdevs.tw',
  'wss://relay.bitesize-media.com',
  'wss://relay.bitmacro.cloud',
  'wss://relay.bitmacro.io',
  'wss://relay.bitmacro.pro',
  'wss://relay.blkstr.io',
  'wss://relay.bnos.space',
  'wss://relay.bongbong.com',
  'wss://relay.bornheimer.app',
  'wss://relay.braydon.com',
  'wss://relay.brightbolt.net',
  'wss://relay.brightbolt.net/chat',
  'wss://relay.brightbolt.net/inbox',
  'wss://relay.btcforplebs.com',
  'wss://relay.buildingtheneighbourhood.org',
  'wss://relay.bullishbounty.com',
  'wss://relay.cal3b.com',
  'wss://relay.camelus.app',
  'wss://relay.caramboo.com',
  'wss://relay.caramboo.com/inbox',
  'wss://relay.carlos-cdb.top',
  'wss://relay.cashumints.space',
  'wss://relay.chontit.win',
  'wss://relay.chorus.community',
  'wss://relay.cloistr.xyz',
  'wss://relay.cocu.la',
  'wss://relay.cocu.la/inbox',
  'wss://relay.coincreek.com',
  'wss://relay.coinos.io',
  'wss://relay.coinos.pro',
  'wss://relay.comcomponent.com',
  'wss://relay.commonshub.brussels',
  'wss://relay.contextvm.org',
  'wss://relay.copper-idea.com',
  'wss://relay.copylaradio.com',
  'wss://relay.corpum.com',
  'wss://relay.corvusnostr.org',
  'wss://relay.cosmicbolt.net',
  'wss://relay.crostr.com',
  'wss://relay.cxplay.org',
  'wss://relay.cypherflow.ai',
  'wss://relay.d11n.net',
  'wss://relay.daann.xyz',
  'wss://relay.daann.xyz/inbox',
  'wss://relay.danieldaquino.me',
  'wss://relay.dapsnostrrelay.xyz',
  'wss://relay.day.ag',
  'wss://relay.day.ag/inbox',
  'wss://relay.day.ag/xray-yonder',
  'wss://relay.decentnewsroom.com',
  'wss://relay.decentnewsroom.com/haven-zulu',
  'wss://relay.degmods.com',
  'wss://relay.denver.space',
  'wss://relay.dergigi.com',
  'wss://relay.dergigi.com/beacon',
  'wss://relay.dergigi.com/chat',
  'wss://relay.dergigi.com/delta-vertex-quartz',
  'wss://relay.devvul.com',
  'wss://relay.digitalhowl.ch',
  'wss://relay.disobey.dev',
  'wss://relay.divine.video',
  'wss://relay.dolu.dev',
  'wss://relay.dreamith.to',
  'wss://relay.drss.io',
  'wss://relay.edufeed.org',
  'wss://relay.emre.xyz',
  'wss://relay.enclaved.org',
  'wss://relay.endfiat.money',
  'wss://relay.example.com',
  'wss://relay.fckstate.net',
  'wss://relay.fizx.uk',
  'wss://relay.flain.win',
  'wss://relay.floof.sbs',
  'wss://relay.freeplace.nl',
  'wss://relay.froth.zone',
  'wss://relay.fundstr.me',
  'wss://relay.gambit.golf',
  'wss://relay.gasteazi.net',
  'wss://relay.gathr.gives/nexus-haven',
  'wss://relay.geoffrey.one',
  'wss://relay.getalby.com',
  'wss://relay.getsafebox.app',
  'wss://relay.geyser.fund',
  'wss://relay.gifbuddy.lol',
  'wss://relay.goodmorningbitcoin.com',
  'wss://relay.gouchinha.me',
  'wss://relay.groups.nip29.com',
  'wss://relay.groups.nip29.com/raven',
  'wss://relay.guenoel.fr',
  'wss://relay.guggero.org',
  'wss://relay.gulugulu.moe',
  'wss://relay.highlighter.com',
  'wss://relay.hivetalk.org',
  'wss://relay.homeinhk.xyz',
  'wss://relay.hunos.hu',
  'wss://relay.illuminodes.com',
  'wss://relay.immortalist.duckdns.org',
  'wss://relay.ingwie.me',
  'wss://relay.inkan.cc',
  'wss://relay.innis.xyz',
  'wss://relay.internationalright-wing.org',
  'wss://relay.islandbitcoin.com',
  'wss://relay.isolabellart.it.com',
  'wss://relay.isolabellart.it.com/inbox',
  'wss://relay.jabato.space',
  'wss://relay.javi.space',
  'wss://relay.jerseyplebs.com',
  'wss://relay.jerseyplebs.com/anchor',
  'wss://relay.jmoose.rocks',
  'wss://relay.johnnyasantos.com',
  'wss://relay.joomaen.com',
  'wss://relay.jthecodemonkey.xyz',
  'wss://relay.jtron.net',
  'wss://relay.jtron.net/inbox',
  'wss://relay.kamenier-hamer.nl',
  'wss://relay.kcbitcoiners.com',
  'wss://relay.keychat.io',
  'wss://relay.kilombino.com',
  'wss://relay.klabo.world',
  'wss://relay.klockenga.xyz',
  'wss://relay.kreweofkeys.net',
  'wss://relay.kubo.watch',
  'wss://relay.kyhou.duckdns.org:4438',
  'wss://relay.kyhou.duckdns.org:4438/inbox',
  'wss://relay.laantungir.net',
  'wss://relay.lab.rytswd.com',
  'wss://relay.lacompagniemaximus.com',
  'wss://relay.lanacoin-eternity.com',
  'wss://relay.lanavault.space',
  'wss://relay.lawallet.ar',
  'wss://relay.lax1dude.net',
  'wss://relay.lax1dude.net/haven',
  'wss://relay.layer.systems',
  'wss://relay.letsfo.com',
  'wss://relay.lexingtonbitcoin.org',
  'wss://relay.liberbitworld.org',
  'wss://relay.libernet.app',
  'wss://relay.lightning.pub',
  'wss://relay.malxte.de/prism',
  'wss://relay.mananguri.me',
  'wss://relay.mananguri.me/inbox',
  'wss://relay.mananguri.me/outbox',
  'wss://relay.mark0st.xyz',
  'wss://relay.masize.com',
  'wss://relay.mccormick.cx',
  'wss://relay.mcfamily.social',
  'wss://relay.minibits.cash',
  'wss://relay.minibolt.info',
  'wss://relay.mitchelltribe.com',
  'wss://relay.mmwaves.de',
  'wss://relay.mojobus.co',
  'wss://relay.monomi.org',
  'wss://relay.mostro.network',
  'wss://relay.mwaters.net',
  'wss://relay.nakabender.lol',
  'wss://relay.nateeatschicken.xyz',
  'wss://relay.nbswozlfpjuwc4y.boo',
  'wss://relay.nextblock.city',
  'wss://relay.ngengine.org',
  'wss://relay.ngit.dev',
  'wss://relay.nip46.com',
  'wss://relay.noderunners.network',
  'wss://relay.nonesuch.group',
  'wss://relay.nosflare.com',
  'wss://relay.nosotros.app',
  'wss://relay.nostar.org',
  'wss://relay.nosto.re',
  'wss://relay.nostr-check.me',
  'wss://relay.nostr.blockhenge.com',
  'wss://relay.nostr.cyou',
  'wss://relay.nostr.hu',
  'wss://relay.nostr.io',
  'wss://relay.nostr.place',
  'wss://relay.nostr.sc',
  'wss://relay.nostr.watch',
  'wss://relay.nostraddress.com',
  'wss://relay.nostrarabia.com',
  'wss://relay.nostrcheck.me',
  'wss://relay.nostrdam.com',
  'wss://relay.nostrdice.com',
  'wss://relay.nostrdvm.com',
  'wss://relay.nostrhub.fr',
  'wss://relay.nostrian-conquest.com',
  'wss://relay.nostriches.club',
  'wss://relay.nostriot.com',
  'wss://relay.nostromo.social',
  'wss://relay.nostrops.com',
  'wss://relay.nostrplebs.com',
  'wss://relay.nostrverse.net',
  'wss://relay.nostrzh.org',
  'wss://relay.nostrzh.org/inbox',
  'wss://relay.nostrzh.org/internal',
  'wss://relay.nostu.be',
  'wss://relay.nostx.io',
  'wss://relay.noswhere.com',
  'wss://relay.notoshi.win',
  'wss://relay.nsec.app',
  'wss://relay.nsite.lol',
  'wss://relay.nsite.run',
  'wss://relay.nsnip.io',
  'wss://relay.nstr.cc',
  'wss://relay.nuts.cash',
  'wss://relay.nyanko.win',
  'wss://relay.nyanko.win/private',
  'wss://relay.nymchat.app',
  'wss://relay.nyves.nl',
  'wss://relay.og.coop',
  'wss://relay.og.coop/inbox',
  'wss://relay.ohstr.com',
  'wss://relay.ohstr.com/v1',
  'wss://relay.olas.app',
  'wss://relay.openfarmtools.org',
  'wss://relay.openresist.com',
  'wss://relay.orangepill.ovh',
  'wss://relay.orangepill.ovh/jade',
  'wss://relay.patrickulrich.com',
  'wss://relay.patrickulrich.com/chat',
  'wss://relay.patrickulrich.com/marble-xray-flint',
  'wss://relay.paulstephenborile.com',
  'wss://relay.paywithflash.com',
  'wss://relay.peer.ooo',
  'wss://relay.pleb.one',
  'wss://relay.plebeian.market',
  'wss://relay.plume.website',
  'wss://relay.plume.website/inbox',
  'wss://relay.plume.website/inbox/lima',
  'wss://relay.powr.build',
  'wss://relay.powr.build/bravo-zulu',
  'wss://relay.puresignal.news',
  'wss://relay.raybuni.com',
  'wss://relay.redsh1ft.com',
  'wss://relay.reya.su',
  'wss://relay.reya.su/yonder-flint-raven',
  'wss://relay.ripsline.com',
  'wss://relay.ripsline.com/inbox',
  'wss://relay.rkus.se',
  'wss://relay.rkus.se/november',
  'wss://relay.rodbishop.nz',
  'wss://relay.rodbishop.nz/chat',
  'wss://relay.rodbishop.nz/inbox',
  'wss://relay.roro.copylaradio.com',
  'wss://relay.routstr.com',
  'wss://relay.ru.ac.th',
  'wss://relay.s-w.art',
  'wss://relay.sagittarius.copylaradio.com',
  'wss://relay.samt.st',
  'wss://relay.samt.st/foxtrot',
  'wss://relay.satlantis.io',
  'wss://relay.satmaxt.xyz',
  'wss://relay.satnam.pub',
  'wss://relay.satpicks.com',
  'wss://relay.satsdisco.com',
  'wss://relay.satsdisco.com/xenon-november',
  'wss://relay.scuba323.com',
  'wss://relay.scuba323.com/inbox',
  'wss://relay.scuttle.works',
  'wss://relay.seq1.net',
  'wss://relay.sharegap.net',
  'wss://relay.shawnyeager.com',
  'wss://relay.shawnyeager.com/chat',
  'wss://relay.shawnyeager.com/foxtrot-victor',
  'wss://relay.shawnyeager.com/inbox',
  'wss://relay.shawnyeager.com/outbox',
  'wss://relay.shop21.dk',
  'wss://relay.shuymn.me',
  'wss://relay.sigit.io',
  'wss://relay.sincensura.org',
  'wss://relay.snotr.nl:49999',
  'wss://relay.solife.me',
  'wss://relay.solife.me/juliet-yankee-onyx',
  'wss://relay.sovbit.host',
  'wss://relay.spacetomatoes.net',
  'wss://relay.spacetomatoes.net/inbox',
  'wss://relay.stackinsats.net/cipher-tango',
  'wss://relay.staging.commonshub.brussels',
  'wss://relay.staging.commonshub.brussels/internal',
  'wss://relay.staging.dvines.org',
  'wss://relay.staging.plebeian.market',
  'wss://relay.stream',
  'wss://relay.tapestry.ninja',
  'wss://relay.tchncs.de',
  'wss://relay.thebluepulse.com',
  'wss://relay.thedude.cloud',
  'wss://relay.threenine.services',
  'wss://relay.tinfoilhash.com',
  'wss://relay.toastr.net',
  'wss://relay.towardsliberty.com',
  'wss://relay.towardsliberty.com/inbox',
  'wss://relay.travelsats.ar',
  'wss://relay.trotters.cc',
  'wss://relay.trustroots.org',
  'wss://relay.typedcypher.com',
  'wss://relay.unclezo.com',
  'wss://relay.unknown.cloud',
  'wss://relay.unsupervised.online',
  'wss://relay.usefusion.ai',
  'wss://relay.utxo.one',
  'wss://relay.vanderwarker.family',
  'wss://relay.vantis.ninja',
  'wss://relay.veganostr.com',
  'wss://relay.vertexlab.io',
  'wss://relay.vrtmrz.net',
  'wss://relay.wahid.my',
  'wss://relay.wasku.com',
  'wss://relay.wavefunc.live',
  'wss://relay.welikethecoin.com',
  'wss://relay.westernbtc.com',
  'wss://relay.whodat.social',
  'wss://relay.wikifreedia.xyz',
  'wss://relay.willen.tech',
  'wss://relay.xavierdamman.com',
  'wss://relay.ygg.gratis',
  'wss://relay.yggr.xyz',
  'wss://relay.ynniv.com',
  'wss://relay.zap.land',
  'wss://relay.zapstore.dev',
  'wss://relay.ziomc.com',
  'wss://relay.zone667.com',
  'wss://relay.zone667.com/uniform-lantern-juliet',
  'wss://relay01.lnfi.network',
  'wss://relay02.lnfi.network',
  'wss://relay1.blackbyte.nl',
  'wss://relay1.nostrchat.io',
  'wss://relay1.ustun.pro',
  'wss://relay2.angor.io',
  'wss://relay2.blackbyte.nl',
  'wss://relay2.contextvm.org',
  'wss://relay2.getalby.com',
  'wss://relay2.ngengine.org',
  'wss://relay2.nostrchat.io',
  'wss://relay2.sovereignengineering.io',
  'wss://relay2.sovereignengineering.io/ember',
  'wss://relay2.veganostr.com',
  'wss://relay29.notoshi.win',
  'wss://relay3.openvine.co',
  'wss://relayone.geektank.ai',
  'wss://relayone.soundhsa.com',
  'wss://relaypag.es',
  'wss://relayrs.notoshi.win',
  'wss://relays.land/nosteam',
  'wss://relays.land/spatianostra/staging',
  'wss://rele.speyhard.fi',
  'wss://rele.speyhard.fi/nostr',
  'wss://reraw.pbla2fish.cc',
  'wss://ribo.eu.nostria.app',
  'wss://ribo.nostria.app',
  'wss://ribo.us.nostria.app',
  'wss://riley.timegate.co',
  'wss://rilo.nostria.app',
  'wss://rn1.sotiras.org/tango',
  'wss://rrr.pupupu.monster',
  'wss://s.basspistol.org',
  'wss://sammyjaved.com/relay',
  'wss://satsage.xyz',
  'wss://schnorr.me',
  'wss://search.nos.today',
  'wss://seattle.bitcoinwalk.org',
  'wss://sgl.rustcorp.com.au',
  'wss://shadow.relay.stream',
  'wss://shitpost.poridge.club',
  'wss://shota.house',
  'wss://shu01.shugur.net',
  'wss://shu02.shugur.net',
  'wss://shu03.shugur.net',
  'wss://shu04.shugur.net',
  'wss://shu05.shugur.net/yonder-hotel-zulu',
  'wss://sign.siamstr.com',
  'wss://sistercharge.scuba323.com/relay',
  'wss://sketch.nostr1.com',
  'wss://sketch.nostr1.com/sierra',
  'wss://slick.mjex.me',
  'wss://smesh.lol',
  'wss://smesh.lol/karma-ember',
  'wss://snnr.flyingcart.kr',
  'wss://snowflare.cc',
  'wss://social.olsentribe.fyi',
  'wss://social.protest.net/relay',
  'wss://soloco.nl',
  'wss://sp1.kanagrovv.kozow.com',
  'wss://spatia-arcana.com',
  'wss://spatia-arcana.com/inbox',
  'wss://spatia-arcana.com/internal',
  'wss://spatia-arcana.com/lux',
  'wss://spatia-arcana.com/nox',
  'wss://spookstr2.nostr1.com',
  'wss://sprout.kanagrovv.kozow.com',
  'wss://srcr.nl:8443',
  'wss://srtrelay.c-stellar.net',
  'wss://staging.yabu.me',
  'wss://straycat.brainstorm.social/relay',
  'wss://straycat.brainstorm.social/relay/umbra-glyph-karma',
  'wss://strfry.apps3.slidestr.net',
  'wss://strfry.atlantislabs.space/whiskey-prism',
  'wss://strfry.bonsai.com',
  'wss://strfry.corebreach.com',
  'wss://strfry.openhoofd.nl',
  'wss://strfry.shock.network',
  'wss://strfry.ymir.cloud',
  'wss://submarin.online',
  'wss://subnet.relays.land',
  'wss://support.nostr1.com',
  'wss://sushi.ski',
  'wss://swarm.hivetalk.org',
  'wss://swarm.hivetalk.org/foxtrot-ivory',
  'wss://syb.lol',
  'wss://syndicate.basspistol.org',
  'wss://syndicate.basspistol.org/inbox',
  'wss://syndicate.basspistol.org/inbox/onyx',
  'wss://syndicate.basspistol.org/papa-beacon-haven',
  'wss://talon.quest',
  'wss://tamby.mjex.me',
  'wss://temp.iris.to',
  'wss://test.nfrelay.app',
  'wss://test.thedude.cloud',
  'wss://testing.gathr.gives/kilo-onyx-whiskey',
  'wss://testnet-relay.samt.st',
  'wss://testnet-relay.samt.st/raven-cipher',
  'wss://testr.nymble.world',
  'wss://the-refinery.spaces.coracle.social',
  'wss://thebarn.nostr1.com',
  'wss://thecitadel.nostr1.com',
  'wss://thecitadel.nostr1.com/sierra-hotel-golf',
  'wss://theforest.nostr1.com',
  'wss://thingstr-relay.fly.dev',
  'wss://thingstr-relay.fly.dev/marble-india',
  'wss://top.testrelay.top',
  'wss://topic.relays.land/ask',
  'wss://topic.relays.land/praise',
  'wss://tortellino.basspistol.org',
  'wss://tortellino.basspistol.org/chat',
  'wss://tortellino.basspistol.org/chat/uniform-charlie',
  'wss://trending.relays.land',
  'wss://treuzkas.branruz.com',
  'wss://trobades.kilombino.com',
  'wss://u2p.anhkagi.net',
  'wss://uk.zap.watch',
  'wss://uk.zap.watch/lantern-titan',
  'wss://undersound.link',
  'wss://unostr.one',
  'wss://us-east.nostr.pikachat.org',
  'wss://us.azzamo.net',
  'wss://us.azzamo.net/lantern-golf-oscar',
  'wss://us.nostr.wine',
  'wss://us.zap.watch',
  'wss://user.kindpag.es',
  'wss://v2.fly.dev',
  'wss://vampire.nostr1.com',
  'wss://vampire.nostr1.com/foxtrot',
  'wss://vault.iris.to',
  'wss://vitor.nostr1.com',
  'wss://wbc.nostr1.com',
  'wss://wheat.happytavern.co',
  'wss://willow.timegate.co',
  'wss://wot.azzamo.net/sierra',
  'wss://wot.brightbolt.net',
  'wss://wot.codingarena.top',
  'wss://wot.czas.plus',
  'wss://wot.danieldaquino.me',
  'wss://wot.dergigi.com',
  'wss://wot.girino.org',
  'wss://wot.grapevine.network',
  'wss://wot.grapevine.network/nexus-haven',
  'wss://wot.makenomistakes.ca',
  'wss://wot.nostr.net/kilo',
  'wss://wot.nostr.place',
  'wss://wot.nostr.sats4.life',
  'wss://wot.nostr.sats4.life/chat',
  'wss://wot.nostr.sats4.life/inbox',
  'wss://wot.relayted.de',
  'wss://wot.sebastix.social',
  'wss://wot.shaving.kiwi',
  'wss://wot.sudocarlos.com',
  'wss://wot.tamby.mjex.me',
  'wss://wot.tealeaf.dev',
  'wss://wot.utxo.one/inbox',
  'wss://wot.yesnostr.net',
  'wss://www.nostr.ltd',
  'wss://x.kojira.io',
  'wss://x.kojira.io/glyph-oscar-sable',
  'wss://xmr.ithurtswhenip.ee',
  'wss://xmr.ithurtswhenip.ee/foxtrot-ember',
  'wss://xmr.ithurtswhenip.ee/juliet-beacon',
  'wss://xmr.usenostr.org',
  'wss://yestr.me',
  'wss://ynostr.yael.at/titan-sable-dynamo',
  'wss://zap.watch',
  'wss://zapbox.relays.land',
];

/** Configuration */
const RELAY_TIMEOUT_MS = 5000;
/** Max simultaneous relay connections across the whole drain (our resource cap) */
const GLOBAL_CONCURRENCY = 50;
/** A relay is never contacted by more than one lane at a time (per-host politeness) */
const TTL_MS = 48 * 60 * 60 * 1000; // 48h: abandon + prune a job after this
/** Per-relay retry backoff by attempt count (index = attempts-1), last value repeats */
const BACKOFF_MS = [5 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 12 * 60 * 60_000];

/** System-log category + stable line keys for the 2-line live progress display */
const LOG_CATEGORY = 'DeleteService';
const LINE_HEADER = 'delete-broadcast:header'; // line 1 (constant): which event is being deleted
const LINE_RELAY = 'delete-broadcast:relay'; // line 2 (swaps): current relay + status diode

/** Outcome of a single relay send */
type SendOutcome = 'ok' | 'rejected' | 'failed';

/** Live progress for a silent (addon-driven) broadcast — not persisted. */
export interface BroadcastProgress {
  jobId: string;
  host: string;
  contacted: number;
  total: number;
  /** Last relay's outcome (true = accepted) — for the on-page green/red diode. */
  ok: boolean;
  done: boolean;
}

/** Options for a single broadcast. */
export interface BroadcastOptions {
  /** Suppress the System Log progress lines (Bulk Delete shows progress on-page). */
  silent?: boolean;
}

export class BroadcastDeleteService {
  private static instance: BroadcastDeleteService;
  private systemLogger: SystemLogger;
  private store: DeleteBroadcastStore;

  /**
   * Live progress subscribers for silent jobs. Global (not per-job/per-view), so
   * a re-mounted Bulk Delete view can re-attach and keep showing progress, and
   * unsubscribing on destroy avoids retaining a dead view for the job's lifetime.
   */
  private silentProgressSubs = new Set<(p: BroadcastProgress) => void>();

  /** Single-flight guard: only one drain pass runs at a time */
  private draining = false;
  /** Set when a trigger fires mid-drain so we loop once more afterwards */
  private drainQueued = false;
  /** Timer that wakes the next drain when relays are waiting on backoff */
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Resume triggers (app resume, visibility, connectivity) are wired only once */
  private resumeWired = false;

  private constructor() {
    this.systemLogger = SystemLogger.getInstance();
    this.store = DeleteBroadcastStore.getInstance();
  }

  static getInstance(): BroadcastDeleteService {
    if (!BroadcastDeleteService.instance) {
      BroadcastDeleteService.instance = new BroadcastDeleteService();
    }
    return BroadcastDeleteService.instance;
  }

  /**
   * Queue a signed deletion event for broadcast to 1400+ relays, then drain in
   * the background. Fire-and-forget — never throws, never blocks. The job is
   * persisted BEFORE the first send, so it survives a reload/crash/app-quit and
   * resumes on the next launch (see resumePending).
   */
  broadcastInBackground(
    signedEvent: SignedNostrEvent,
    opts: BroadcastOptions = {}
  ): void {
    void this.enqueueAndDrain(signedEvent, opts).catch(error => {
      this.systemLogger.error('BroadcastDelete', `Unexpected error: ${error}`);
    });
  }

  /** Subscribe to live progress of every silent job. Returns an unsubscribe fn. */
  subscribeProgress(cb: (p: BroadcastProgress) => void): () => void {
    this.silentProgressSubs.add(cb);
    return () => {
      this.silentProgressSubs.delete(cb);
    };
  }

  /** Count silent (addon-driven) jobs still persisted/in-flight. */
  async countActiveSilentJobs(): Promise<number> {
    const jobs = await this.store.getAllJobs();
    return jobs.filter(j => j.silent).length;
  }

  /**
   * Aggregate delivery state across all silent jobs, or null if none are running.
   * `contacted` = relays attempted at least once (first-pass progress); when it
   * reaches `total` the deletion has been delivered to every reachable relay and
   * only dead-relay retries remain in the background.
   */
  async getSilentProgress(): Promise<{
    total: number;
    contacted: number;
    sent: number;
  } | null> {
    const jobs = (await this.store.getAllJobs()).filter(j => j.silent);
    if (jobs.length === 0) return null;
    let total = 0,
      contacted = 0,
      sent = 0;
    for (const job of jobs) {
      for (const s of Object.values(job.relays)) {
        total++;
        if (s.status === 'sent') {
          sent++;
          contacted++;
        } else if (s.status === 'rejected' || s.attempts > 0) contacted++;
      }
    }
    return { total, contacted, sent };
  }

  private notifySilent(p: BroadcastProgress): void {
    for (const cb of this.silentProgressSubs) {
      try {
        cb(p);
      } catch {
        /* a dead subscriber must not break the drain */
      }
    }
  }

  /**
   * Resume any persisted, unfinished broadcast jobs. Safe to call repeatedly —
   * call on app start and whenever the app/network comes back.
   */
  resumePending(): void {
    this.wireResumeTriggers();
    void this.scheduleDrain();
  }

  /** Build the job's relay set and persist it, then kick off draining. */
  private async enqueueAndDrain(
    signedEvent: SignedNostrEvent,
    opts: BroadcastOptions = {}
  ): Promise<void> {
    this.wireResumeTriggers();

    // Build full relay set: hardcoded + aggregator relays.
    const relayConfig = RelayConfig.getInstance();
    const fullRelaySet = new Set(BROADCAST_RELAYS);
    for (const relay of relayConfig.getAggregatorRelays()) {
      fullRelaySet.add(relay);
    }

    // The user's own relays (Relay Settings) go FIRST — they're the primary
    // target since the note actually lives there. DeletionService already
    // published to them synchronously; including them here too (not excluding)
    // gives them the resumable retry guarantee, not just that one-shot publish.
    const ownRelays = relayConfig
      .getAllRelays()
      .filter(r => r.isActive)
      .map(r => r.url);
    const ownSet = new Set(ownRelays);
    const broadcastRelays = [
      ...ownRelays,
      ...[...fullRelaySet].filter(r => !ownSet.has(r)),
    ];

    if (broadcastRelays.length === 0) {
      this.systemLogger.info(
        'BroadcastDelete',
        'No additional relays to broadcast to'
      );
      return;
    }

    const now = Date.now();
    const relays: BroadcastJob['relays'] = {};
    for (const url of broadcastRelays) {
      relays[url] = { status: 'pending', attempts: 0, nextAttemptAt: now };
    }
    const job: BroadcastJob = {
      id: signedEvent.id,
      event: signedEvent as StoredSignedEvent,
      createdAt: now,
      expiresAt: now + TTL_MS,
      relays,
    };
    if (opts.silent) job.silent = true;

    await this.store.putJob(job);
    diagLog('relays', 'Delete broadcast queued', {
      event: job.id,
      relays: broadcastRelays.length,
      silent: !!opts.silent,
    });
    // Constant header line (line 1) — shows immediately on click (System-Log jobs only).
    this.reportHeader(job);

    await this.scheduleDrain();
  }

  /**
   * Single-flight drain loop. Coalesces overlapping triggers into one pass and
   * re-runs if another trigger fired while it was working.
   */
  private async scheduleDrain(): Promise<void> {
    if (this.draining) {
      this.drainQueued = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.drainQueued = false;
        await this.drainOnce();
      } while (this.drainQueued);
    } catch (error) {
      this.systemLogger.error('BroadcastDelete', `Drain failed: ${String(error)}`);
    } finally {
      this.draining = false;
    }
  }

  /**
   * Process every relay that is currently due across all stored jobs. Expired
   * jobs are pruned. Relays still waiting on backoff schedule a wake timer.
   */
  private async drainOnce(): Promise<void> {
    const jobs = await this.store.getAllJobs();
    if (jobs.length === 0) return;

    const now = Date.now();

    // Collect due relays (and prune expired jobs) — group into per-host lanes so
    // a single host is never hit by more than one connection at a time.
    const lanesByHost = new Map<
      string,
      Array<{ job: BroadcastJob; url: string }>
    >();
    let earliestFuture = Infinity;

    for (const job of jobs) {
      if (now >= job.expiresAt) {
        await this.finalizeJob(job, true);
        continue;
      }
      for (const [url, state] of Object.entries(job.relays)) {
        if (state.status !== 'pending') continue;
        if (state.nextAttemptAt > now) {
          if (state.nextAttemptAt < earliestFuture)
            earliestFuture = state.nextAttemptAt;
          continue;
        }
        const host = this.hostOf(url);
        const lane = lanesByHost.get(host) ?? [];
        lane.push({ job, url });
        lanesByHost.set(host, lane);
      }
    }

    const lanes = [...lanesByHost.values()];
    if (lanes.length === 0) {
      this.scheduleWake(earliestFuture, now);
      return;
    }

    // Run lanes with bounded concurrency. Within a lane, relays are sent
    // sequentially (per-host concurrency = 1); up to GLOBAL_CONCURRENCY lanes
    // run at once. Checkpoint progress to IndexedDB periodically.
    const dirty = new Set<BroadcastJob>();
    let sinceCheckpoint = 0;

    // Keep the constant header line visible while sending (covers resume too).
    this.reportHeader(lanes[0]![0]!.job);

    await this.runLanes(lanes, GLOBAL_CONCURRENCY, async lane => {
      for (const { job, url } of lane) {
        const outcome = await this.publishToRelay(url, job.event);
        this.applyOutcome(job, url, outcome);
        this.reportRelay(job, url, outcome);
        dirty.add(job);
        if (++sinceCheckpoint >= 100) {
          sinceCheckpoint = 0;
          await this.checkpoint(dirty);
        }
      }
    });

    // Final persist / finalize for everything we touched.
    for (const job of dirty) {
      await this.finalizeJob(job, false);
    }

    // If anything is still pending on backoff, schedule the next wake.
    earliestFuture = Infinity;
    for (const job of await this.store.getAllJobs()) {
      for (const state of Object.values(job.relays)) {
        if (
          state.status === 'pending' &&
          state.nextAttemptAt < earliestFuture
        ) {
          earliestFuture = state.nextAttemptAt;
        }
      }
    }
    this.scheduleWake(earliestFuture, Date.now());
  }

  /** Update a relay's state from a send outcome. */
  private applyOutcome(
    job: BroadcastJob,
    url: string,
    outcome: SendOutcome
  ): void {
    const state = job.relays[url];
    if (!state) return;
    if (outcome === 'ok') {
      state.status = 'sent';
    } else if (outcome === 'rejected') {
      // Relay answered "no" (e.g. blocked / unknown event) — definitive, no retry.
      state.status = 'rejected';
    } else {
      // No response (timeout / connection error) — back off and retry later.
      state.attempts += 1;
      const delay =
        BACKOFF_MS[Math.min(state.attempts - 1, BACKOFF_MS.length - 1)]!;
      state.nextAttemptAt = Date.now() + delay;
    }
  }

  /** Persist the given jobs (coarse checkpoint; duplicate sends are harmless). */
  private async checkpoint(jobs: Set<BroadcastJob>): Promise<void> {
    for (const job of jobs) {
      await this.store.putJob(job);
    }
  }

  /**
   * Persist a job, or delete it once every relay is resolved (sent/rejected) or
   * the job has expired. The 2-line System Log progress is left at its final
   * state (no extra closing line — the output stays at 2 lines by design).
   */
  private async finalizeJob(
    job: BroadcastJob,
    expired: boolean
  ): Promise<void> {
    const states = Object.values(job.relays);
    const allResolved = states.every(s => s.status !== 'pending');
    if (expired || allResolved) {
      await this.store.deleteJob(job.id);
      const sent = states.filter(s => s.status === 'sent').length;
      diagLog(
        'relays',
        expired && !allResolved
          ? 'Delete broadcast expired (48h)'
          : 'Delete broadcast complete',
        {
          event: job.id,
          sent,
          total: states.length,
        }
      );
      if (job.silent) {
        this.notifySilent({
          jobId: job.id,
          host: '',
          contacted: states.length,
          total: states.length,
          ok: true,
          done: true,
        });
      }
    } else {
      await this.store.putJob(job);
    }
  }

  /** Line 1 (constant): which event is being deleted. No counter. Silent jobs skip the System Log. */
  private reportHeader(job: BroadcastJob): void {
    if (job.silent) return;
    const shortId = job.id.length > 12 ? `${job.id.slice(0, 12)}…` : job.id;
    this.systemLogger.setLine(
      LINE_HEADER,
      'info',
      LOG_CATEGORY,
      `Deleting event ${shortId}`,
      undefined,
      false
    );
  }

  /**
   * Per-relay progress. For normal jobs: line 2 in the System Log (swapping relay
   * + green/red diode + "(done/total)" counter scoped to THIS broadcast). For
   * silent jobs (Bulk Delete): no System Log — fire the live progress callback
   * instead (only while one is registered; nothing on a resumed silent job).
   */
  private reportRelay(
    job: BroadcastJob,
    url: string,
    outcome: SendOutcome
  ): void {
    const ok = outcome === 'ok';
    const states = Object.values(job.relays);
    const total = states.length;
    const contacted = states.filter(
      s => s.status !== 'pending' || s.attempts > 0
    ).length;

    if (job.silent) {
      this.notifySilent({
        jobId: job.id,
        host: this.hostOf(url),
        contacted,
        total,
        ok,
        done: false,
      });
      return;
    }

    this.systemLogger.setLine(
      LINE_RELAY,
      ok ? 'success' : 'error',
      LOG_CATEGORY,
      `Sending request to ${this.hostOf(url)} (${contacted}/${total})`,
      ok ? 'success' : 'error',
      false
    );
  }

  /** Schedule (or reschedule) a one-shot wake for the earliest pending backoff. */
  private scheduleWake(earliestFuture: number, now: number): void {
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    if (!isFinite(earliestFuture)) return;
    const delay = Math.max(1000, earliestFuture - now);
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      void this.scheduleDrain();
    }, delay);
  }

  /**
   * Run lanes with bounded concurrency. Each lane is processed by `worker`;
   * at most `concurrency` lanes run simultaneously.
   */
  private async runLanes<T>(
    lanes: T[],
    concurrency: number,
    worker: (lane: T) => Promise<void>
  ): Promise<void> {
    let cursor = 0;
    const runNext = async (): Promise<void> => {
      while (cursor < lanes.length) {
        const lane = lanes[cursor++]!;
        await worker(lane);
      }
    };
    const workers = Array.from(
      { length: Math.min(concurrency, lanes.length) },
      () => runNext()
    );
    await Promise.all(workers);
  }

  /** Extract the host (for per-host politeness). Falls back to the raw URL. */
  private hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  /**
   * Wire resume triggers once: app resume (mobile), tab visibility (web), and
   * network coming back online. Each just nudges the drain; the drain itself
   * decides which relays are due.
   */
  private wireResumeTriggers(): void {
    if (this.resumeWired) return;
    this.resumeWired = true;

    try {
      TypedEventBus.getInstance().on(
        'connectivity:status',
        ({ online }: { online: boolean }) => {
          if (online) void this.scheduleDrain();
        }
      );
    } catch {
      /* event bus unavailable — ignore */
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void this.scheduleDrain();
      });
    }

    // Capacitor native resume (Android) — best-effort, only if the plugin exists.
    import('@capacitor/app')
      .then(({ App }) =>
        App.addListener('resume', () => {
          void this.scheduleDrain();
        })
      )
      .catch(() => {
        /* not on Capacitor / no listener support — ignore */
      });
  }

  /**
   * Publish event to a single relay via raw WebSocket.
   * Resolves 'ok' (OK true), 'rejected' (OK false — final), or 'failed'
   * (timeout / connection error — retryable). Never throws.
   */
  private publishToRelay(
    relayUrl: string,
    event: StoredSignedEvent
  ): Promise<SendOutcome> {
    return new Promise(resolve => {
      let settled = false;

      const finish = (outcome: SendOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        resolve(outcome);
      };

      const timer = setTimeout(() => finish('failed'), RELAY_TIMEOUT_MS);

      let ws: WebSocket;
      try {
        ws = new WebSocket(relayUrl);
      } catch {
        finish('failed');
        return;
      }

      ws.onopen = () => {
        try {
          ws.send(JSON.stringify(['EVENT', event]));
        } catch {
          finish('failed');
        }
      };

      ws.onmessage = msg => {
        try {
          const data = JSON.parse(msg.data);
          // NIP-01 OK message: ["OK", <event_id>, <true|false>, <message>]
          if (data[0] === 'OK' && data[1] === event.id) {
            finish(data[2] === true ? 'ok' : 'rejected');
          }
        } catch {
          // Ignore parse errors (NOTICE, EOSE, etc.)
        }
      };

      ws.onerror = () => finish('failed');
    });
  }
}
