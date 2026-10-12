/**
 * Shared relay resolution for the calendar addon: read + aggregator relays
 * plus the NIP-65 outboxes of the given pubkeys (own events live on own
 * write relays; RSVPs on responder write relays). Mirrors the established
 * analytics/collectors.ts strategy.
 */

import { capRelayHints } from '../../helpers/capRelayHints';
import { RelayConfig } from '../../services/RelayConfig';
import { OutboundRelaysOrchestrator } from '../../services/orchestration/OutboundRelaysOrchestrator';

export async function resolveCalendarRelays(
  pubkeys: string[]
): Promise<string[]> {
  const relayConfig = RelayConfig.getInstance();
  const base = [
    ...new Set([
      ...relayConfig.getReadRelays(),
      ...relayConfig.getAggregatorRelays(),
    ]),
  ];
  if (pubkeys.length === 0) return base;
  try {
    const outbound =
      await OutboundRelaysOrchestrator.getInstance().getCombinedRelays(
        [...new Set(pubkeys)],
        true
      );
    return [...new Set([...base, ...outbound])];
  } catch {
    return base;
  }
}

/** Max relays taken from the event owner's NIP-65 list for RSVP targets. */
export const RSVP_OWNER_RELAY_CAP = 8;

function isRelayUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'wss:' || parsed.protocol === 'ws:';
  } catch {
    return false;
  }
}

/**
 * Relay targets for an OUTGOING RSVP (kind 31925): everything of the current
 * user (= responder; write + read + aggregator) plus the event owner's full
 * NIP-65 relay list (write + read). The owner's dashboard / RSVP aggregation
 * queries exactly that set (resolveCalendarRelays from their side), so an
 * RSVP from a guest with a disjoint relay set must land on at least one owner
 * relay — otherwise the host never sees the booking and slot collision
 * protection silently fails. Mirrors the cal.emre.xyz rule: host relays +
 * booker relays + defaults.
 */
export async function resolveRSVPRelayTargets(
  ownerPubkey: string
): Promise<string[]> {
  const relayConfig = RelayConfig.getInstance();
  const base = [
    ...new Set([
      ...relayConfig.getWriteRelays(),
      ...relayConfig.getReadRelays(),
      ...relayConfig.getAggregatorRelays(),
    ]),
  ];
  try {
    const lists =
      await OutboundRelaysOrchestrator.getInstance().discoverUserRelays([
        ownerPubkey,
      ]);
    const ownerRelays = lists
      .flatMap(list => [...list.writeRelays, ...list.readRelays])
      .filter(isRelayUrl);
    return capRelayHints(base, ownerRelays, base.length + RSVP_OWNER_RELAY_CAP);
  } catch {
    return base;
  }
}
