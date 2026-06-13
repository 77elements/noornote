/**
 * Shared base relay config for the 5 content editors. TEST mode → local relay
 * only; else all active relays available + write relays pre-selected.
 * (Note/reply layer a timeline-filter override on top.)
 */

import type { RelayConfig } from '../services/RelayConfig';

export interface EditorRelayConfig {
  isTestMode: boolean;
  availableRelays: string[];
  selectedRelays: Set<string>;
}

export function loadEditorRelayConfig(relayConfig: RelayConfig): EditorRelayConfig {
  const local = relayConfig.loadLocalRelaySettings();
  if (local.enabled) {
    return {
      isTestMode: true,
      availableRelays: [local.url],
      selectedRelays: new Set([local.url]),
    };
  }

  const availableRelays = [...new Set(relayConfig.getAllRelays().filter(r => r.isActive).map(r => r.url))];
  const selectedRelays = new Set(relayConfig.getWriteRelays());
  return { isTestMode: false, availableRelays, selectedRelays };
}
