/**
 * Control-Plane channel discovery — reads Channel definitions from a
 * community's Control Plane using only the invite material.
 *
 * CORD-02 §5 (split stream keys):
 *   - The Control Plane's ADDRESS (`control_pk`) is derived from the
 *     staff-held `control_root` — members never hold it, they only receive
 *     `control_pk` inside the invite bundle.
 *   - The wraps' CONTENT is encrypted under a read key every member derives:
 *     `control_conv_key = group_key("concord/control", community_root,
 *                                    community_id, epoch).conv_key`
 *
 * CORD-02 §5 (seal form): the Control Plane uses PLAINTEXT seals
 * (kind 20014) — the seal's content is the rumor's serialized JSON string,
 * byte-verbatim, so compaction can re-wrap signed editions across epochs.
 *
 * CORD-04 §1 (editions): each edition is a kind-3308 rumor with tags
 * `["vsk", <entity type>]`, `["eid", <entity id>]`, `["ev", <version>]`.
 * ChannelMetadata is vsk "2" (Armada kinds.ts VSK_CHANNEL); its `eid` IS
 * the channel_id and its content is `{"name": …, "private": …}`.
 *
 * Result: from the invite link alone (community_root + community_id +
 * control_pk + relays), we can read the full channel list — no second URL.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { nip44DecryptWithKey } from '../../../services/NostrToolsAdapter';
import { controlGroupKey } from './concordGroupKey';
import { ArmadaRelayClient } from './ArmadaRelayClient';
import { diagLog } from '../../../services/DiagnosticLogger';

const KIND_WRAP = 1059;
const KIND_SEAL_PLAINTEXT = 20014;
const KIND_EDITION = 3308;
const VSK_CHANNEL = '2';

export interface DiscoveredChannel {
  id: string;
  name: string;
  isPrivate: boolean;
}

/**
 * Discover a community's channels from its Control Plane.
 *
 * @param communityRoot 64-char hex — from the invite bundle
 * @param communityId   64-char hex — from the invite bundle
 * @param controlPk     64-char hex — the Control Plane address, from the bundle
 * @param rootEpoch     numeric epoch (0 for fresh communities)
 * @param relays        the community's relays (bundle `relays`)
 * @returns the community's channels (may be empty if the plane has no
 *          ChannelMetadata editions, e.g. legacy or unreachable relays)
 */
export async function discoverChannelsFromControlPlane(
  communityRoot: string,
  communityId: string,
  controlPk: string,
  rootEpoch: number,
  relays: string[],
): Promise<DiscoveredChannel[]> {
  // Read key every member derives (CORD-02 §5). NOTE: this key's .pk is NOT
  // the plane's address — that one comes from the staff-held control_root.
  // Only the convKey matters here.
  const readKey = controlGroupKey(communityRoot, communityId, rootEpoch);

  const client = new ArmadaRelayClient();
  const events = await client.fetchWraps(relays, [controlPk], 0);
  client.destroy();

  if (events.length === 0) {
    diagLog('addons', 'armada: control plane empty on relays', { controlPk: controlPk.slice(0, 12) });
    return [];
  }

  // Fold editions per entity: highest version wins (CORD-04 §4 fold).
  // We only need ChannelMetadata (vsk 2) entities.
  const heads = new Map<string, { version: number; name: string; isPrivate: boolean; deleted: boolean }>();

  for (const wrap of events) {
    if (wrap.kind !== KIND_WRAP) continue;
    try {
      // Step 1: decrypt the wrap's content with the member read key → seal.
      const sealJson = nip44DecryptWithKey(wrap.content, readKey.convKey);
      const seal = JSON.parse(sealJson) as NostrEvent;
      if (seal.kind !== KIND_SEAL_PLAINTEXT) continue; // Control is plaintext-sealed

      // Step 2: plaintext seal → the rumor JSON rides verbatim in seal.content.
      const rumor = JSON.parse(seal.content) as NostrEvent;
      if (rumor.kind !== KIND_EDITION) continue;

      const vsk = rumor.tags.find(t => t[0] === 'vsk')?.[1];
      if (vsk !== VSK_CHANNEL) continue;

      const channelId = rumor.tags.find(t => t[0] === 'eid')?.[1];
      const version = Number(rumor.tags.find(t => t[0] === 'ev')?.[1] ?? 0);
      if (!channelId || !/^[0-9a-f]{64}$/.test(channelId)) continue;

      // Fold: refuse downgrade — only a higher version replaces the head.
      const existing = heads.get(channelId);
      if (existing && existing.version >= version) continue;

      let name = '';
      let isPrivate = false;
      let deleted = false;
      try {
        const meta = JSON.parse(rumor.content);
        name = typeof meta.name === 'string' ? meta.name : '';
        isPrivate = meta.private === true;
        deleted = meta.deleted === true;
      } catch { /* malformed content — treat as unnamed, not fatal */ }

      heads.set(channelId, { version, name, isPrivate, deleted });
    } catch {
      // Wrong key or malformed wrap — skip this event.
    }
  }

  const channels: DiscoveredChannel[] = [];
  for (const [id, head] of heads) {
    if (head.deleted) continue; // deletion is terminal (CORD-03 §2)
    channels.push({ id, name: head.name, isPrivate: head.isPrivate });
  }

  diagLog('addons', 'armada: channel discovery complete', {
    controlPk: controlPk.slice(0, 12),
    wraps: events.length,
    channels: channels.length,
    names: channels.map(c => c.name || c.id.slice(0, 8)),
  });

  return channels;
}
