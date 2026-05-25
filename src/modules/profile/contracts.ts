import type { Profile } from '../../services/orchestration/ProfileOrchestrator';

export type { Profile };

export interface ProfileModuleApi {
  fetchProfile(pubkey: string): Promise<Profile | null>;
  fetchMultipleProfiles(pubkeys: string[]): Promise<Map<string, Profile>>;
  fetchOldestEvent(pubkey: string): Promise<number | null>;
}
