/**
 * Shared relay resolution for the calendar addon: read + aggregator relays
 * plus the NIP-65 outboxes of the given pubkeys (own events live on own
 * write relays; RSVPs on responder write relays). Mirrors the established
 * analytics/collectors.ts strategy.
 */

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
