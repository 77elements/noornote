/**
 * ProfileEncounterFileStorage
 * File-based storage for profile recognition encounters using Tauri FS API
 *
 * Stores first encounter snapshots for followed users:
 * - ~/.noornote/{npub}/profile-encounters.json
 * - Tracks first name/picture at follow time
 * - Tracks last known name/picture for change detection
 * - Single source of truth for profile recognition
 */

import { BaseFileStorage, type BaseFileData } from './BaseFileStorage';

/**
 * Profile encounter snapshot
 */
export interface ProfileEncounter {
  firstName: string;
  firstPictureUrl: string;
  firstSeenAt: number;
  lastKnownName: string;
  lastKnownPictureUrl: string;
  lastChangedAt: number;
}

export interface ProfileEncounterData extends BaseFileData {
  encounters: {
    [pubkey: string]: ProfileEncounter;
  };
}

/**
 * ProfileEncounterFileStorage - Manages profile encounter persistence
 */
export class ProfileEncounterFileStorage extends BaseFileStorage<ProfileEncounterData> {
  private static instance: ProfileEncounterFileStorage;

  private constructor() {
    super();
  }

  public static getInstance(): ProfileEncounterFileStorage {
    if (!ProfileEncounterFileStorage.instance) {
      ProfileEncounterFileStorage.instance = new ProfileEncounterFileStorage();
    }
    return ProfileEncounterFileStorage.instance;
  }

  protected getFileName(): string {
    return 'profile-encounters.json';
  }

  protected getDefaultData(): ProfileEncounterData {
    return {
      encounters: {},
      lastModified: Math.floor(Date.now() / 1000)
    };
  }

  protected getLoggerName(): string {
    return 'ProfileEncounterFileStorage';
  }
}
