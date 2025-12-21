/**
 * TribeSetData - Format for NIP-51 Follow Sets (Tribes)
 *
 * This is THE format for tribes everywhere:
 * - localStorage
 * - File (~/.noornote/{npub}/tribes.json)
 * - Relays (kind:30000 events)
 */

export interface TribeMemberTag {
  pubkey: string;
  relay?: string;  // Optional relay hint
}

export interface TribeSet {
  kind: 30000;
  d: string;           // d-tag value (tribe name, "" = root)
  title: string;       // Display name
  publicMembers: TribeMemberTag[];
  privateMembers: TribeMemberTag[];
}

export interface TribeSetData {
  version: 1;
  sets: TribeSet[];
  metadata: {
    setOrder: string[];      // Order of d-tags for UI
    lastModified: number;
  };
}
