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
import type { TrackedCommunity } from './types';

const FETCH_TIMEOUT_MS = 15000;

export type ResolveResult =
  | { kind: 'ok'; community: TrackedCommunity }
  | { kind: 'error'; reason: string };

/**
 * Resolve an Armada invite link (URL or bare naddr#fragment) into a fully
 * decrypted TrackedCommunity, ready to store in the registry.
 */
export async function resolveInvitePreview(input: string): Promise<ResolveResult> {
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
    bootstrapRelays: decoded.relays,
    openUrl: parsed.openUrl,
    addedAt: Date.now(),
  };
  if (preview.icon) community.iconPointer = preview.icon;
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
