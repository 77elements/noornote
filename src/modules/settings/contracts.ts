import type { RelayInfo } from '../../services/RelayConfig';
import type { RelayHealthMetrics } from '../../services/RelayHealthMonitor';
import type { UpdateInfo } from '../../services/UpdateCheckService';

export type { RelayInfo, RelayHealthMetrics, UpdateInfo };

export interface SettingsModuleApi {
  // RelayListOrchestrator
  fetchRelayList(pubkey: string, bootstrapRelays: string[]): Promise<{ relays: RelayInfo[]; timestamp: number } | null>;
  publishRelayList(relays: RelayInfo[], event: import('@nostr-dev-kit/ndk').NostrEvent): Promise<void>;
  relayInfosToTags(relays: RelayInfo[]): string[][];

  // RelayHealthMonitor
  getRelayHealthMetrics(url: string): RelayHealthMetrics | null;
  getHealthSummary(): Promise<{ healthy: number; total: number; warnings: string[] }>;

  // UpdateCheckService
  skipVersion(version: string): void;
  isAutoCheckEnabled(): boolean;
  setAutoCheckEnabled(enabled: boolean): void;
  checkUpdateManually(button: HTMLButtonElement): Promise<void>;
}
