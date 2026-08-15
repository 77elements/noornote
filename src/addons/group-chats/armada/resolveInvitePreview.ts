/**
 * resolveInvitePreview — resolve an Armada invite link to its decrypted preview.
 *
 * Reusable helper extracted from ArmadaInviteRenderer.loadPreview so that
 * both the inline invite card (feed rendering) and the community-registry
 * Add flow (settings UI) share the same parse → decode → fetch → decrypt
 * pipeline.
 *
 * Pipeline:
 *   1. parseArmadaInvite(url)          → { naddr, linkSigner, fragment, … }
 *   2. decodeInviteFragment(fragment)  → { token, relays }
 *   3. NostrTransport.fetchDirect      → bundle event (kind 33301)
 *   4. decodeInviteBundle(event, …, token) → { name, icon, channelCount, … }
 *
 * Returns a structured result: either `{ kind: 'ok', … }` with everything the
 * registry needs to store, or `{ kind: 'error', reason }` with a short
 * user-facing reason string.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { parseArmadaInvite } from '../../../helpers/armada/parseArmadaInvite';
import { decodeInviteFragment } from '../../../helpers/armada/decodeInviteFragment';
import { decodeInviteBundle } from '../../../helpers/armada/decodeInviteBundle';
import { diagLog } from '../../../services/DiagnosticLogger';
import { NostrTransport } from '../../../services/transport/NostrTransport';
import { discoverChannelsFromControlPlane } from './discoverChannels';
import type { TrackedCommunity } from './types';

const FETCH_TIMEOUT_MS = 15000;

export type ResolveResult =
  | { kind: 'ok'; community: TrackedCommunity }
  | { kind: 'error'; reason: string };

/**
 * Parse a community URL (`armada.buzz/c/<communityId>/<channelId>/...`) to
 * extract channel IDs. Returns the array of channel IDs found, or empty.
 */
export function parseChannelIdsFromUrl(url: string): string[] {
  try {
    const u = new URL(url.trim());
    // Path format: /c/<communityId>/<channelId>/...
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'c' || parts.length < 3) return [];
    // parts[1] = communityId, parts[2] = channelId (64-char hex)
    const channelId = parts[2];
    if (channelId && /^[0-9a-f]{64}$/i.test(channelId)) return [channelId];
    // Multiple channels: check all path segments after communityId
    return parts.slice(2).filter(p => /^[0-9a-f]{64}$/i.test(p));
  } catch {
    return [];
  }
}

/**
 * Resolve an Armada invite link (URL or bare naddr#fragment) into a fully
 * decrypted TrackedCommunity, ready to store in the registry.
 *
 * Channel discovery is automatic: the invite bundle carries the
 * `community_root`, `community_id` and `control_pk`; from these the Control
 * Plane's read key derives (CORD-02 §5) and the full channel list falls out
 * of the plane's ChannelMetadata editions (CORD-03 §2, vsk "2"). One paste,
 * one paste only — no second URL.
 */
export async function resolveInvitePreview(
  input: string,
): Promise<ResolveResult> {
  const trimmed = input.trim();
  const parsed = parseArmadaInvite(trimmed);
  if (!parsed) {
    return { kind: 'error', reason: 'Not a recognized Armada invite link.' };
  }
  if (parsed.missingSecret) {
    return { kind: 'error', reason: 'Invite link is missing its unlock secret (the #fragment). Copy the full URL from Armada.' };
  }

  const decoded = decodeInviteFragment(parsed.fragment);
  if (!decoded) {
    diagLog('addons', 'armada: add-community fragment decode failed', { linkSigner: parsed.linkSigner.slice(0, 8) });
    return { kind: 'error', reason: 'Could not decode the invite secret (unsupported format).' };
  }

  const filter = [{
    kinds: [33301],
    authors: [parsed.linkSigner],
    '#d': [''],
    limit: 1,
  }];

  let events: NostrEvent[] = [];
  try {
    events = await NostrTransport.getInstance().fetchDirect(
      decoded.relays,
      filter,
      FETCH_TIMEOUT_MS,
      'ArmadaAddCommunity',
    );
  } catch (error) {
    diagLog('addons', 'armada: add-community fetch threw', { error: String(error) });
  }

  if (events.length === 0) {
    return { kind: 'error', reason: 'Could not find the community on its bootstrap relays. Try again later.' };
  }

  const newest = events.slice().sort((a, b) => b.created_at - a.created_at)[0];
  if (!newest) {
    return { kind: 'error', reason: 'Community bundle was empty.' };
  }

  const preview = decodeInviteBundle(newest, parsed.linkSigner, decoded.token);
  if (!preview) {
    diagLog('addons', 'armada: add-community bundle decrypt failed', { linkSigner: parsed.linkSigner.slice(0, 8) });
    return { kind: 'error', reason: 'Could not decrypt the community preview. The invite link may be expired.' };
  }

  const community: TrackedCommunity = {
    naddr: parsed.naddr,
    linkSigner: parsed.linkSigner,
    fragment: parsed.fragment,
    name: preview.name || 'Encrypted community',
    channelCount: preview.channelCount,
    // Prefer bundle relays (the community's actual relays) over fragment
    // bootstrap relays. The fragment carries the stock dictionary used to
    // locate the bundle; the bundle carries the community's own relay list
    // where messages actually live.
    bootstrapRelays: (preview.relays.length > 0 ? preview.relays : decoded.relays),
    openUrl: parsed.openUrl,
    addedAt: Date.now(),
  };
  if (preview.icon) community.iconPointer = preview.icon;
  if (preview.communityRoot) community.communityRoot = preview.communityRoot;
  if (typeof preview.rootEpoch === 'number') community.rootEpoch = preview.rootEpoch;
  if (preview.communityId) community.communityId = preview.communityId;
  if (preview.controlPk) community.controlPk = preview.controlPk;
  // Channel IDs: bundle-decoded first (private channels granted to this link)
  if (preview.channels && preview.channels.length > 0) {
    community.channels = preview.channels;
  } else if (community.communityRoot && community.communityId && community.controlPk) {
    // Public channels: discover from the Control Plane (CORD-02 §5 read key).
    // Best-effort — on failure the community is still tracked, polling then
    // covers only control-plane activity until channels arrive via re-add.
    try {
      const discovered = await discoverChannelsFromControlPlane(
        community.communityRoot,
        community.communityId,
        community.controlPk,
        community.rootEpoch ?? 0,
        community.bootstrapRelays,
      );
      if (discovered.length > 0) {
        // Public channels only: a private channel's stream key derives from
        // an independent secret (CORD-03 §1) delivered per grant — we hold
        // no such key, so polling it can never fire and it must not occupy
        // the notification deep-link's channels[0] slot.
        const publicChannels = discovered.filter(ch => !ch.isPrivate);
        if (publicChannels.length > 0) {
          community.channels = publicChannels.map(ch => ({
            id: ch.id,
            epoch: community.rootEpoch ?? 0,
            ...(ch.name ? { name: ch.name } : {}),
          }));
          community.channelCount = publicChannels.length;
        }
      }
    } catch (error) {
      diagLog('addons', 'armada: control-plane discovery failed', { error: String(error) });
    }
  }
  if (preview.expired) {
    return { kind: 'error', reason: 'This invite has expired. Ask for a fresh link.' };
  }

  diagLog('addons', 'armada: community resolved', {
    name: community.name,
    channels: community.channelCount,
    hasIcon: !!community.iconPointer,
  });

  return { kind: 'ok', community };
}
