import { wrapEditable } from './blockEditWrapper';
import type { Block } from '../types';

/**
 * Profile Card block — renders a UserIdentity (avatar + display name +
 * NIP-05 handle, clickable to /profile/{npub}). The pubkey is implicit
 * (= page owner) in V1; a per-block override field is on the roadmap.
 *
 * Like the embed and bookmark-folder blocks, the actual mount happens
 * after the page HTML is in the DOM — see profileCardMount.ts.
 */
export function renderProfileCard(block: Extract<Block, { type: 'profile-card' }>, editable = false): string {
  const slot = `<div class="nospress-block-profile-card" data-profile-card-mount data-block-id="${block.id}"${block.pubkey ? ` data-pubkey="${block.pubkey}"` : ''}>
    <div class="nospress-block-profile-card__loading pulsate">Loading profile…</div>
  </div>`;

  if (editable) {
    const hint = `<small class="nospress-block-profile-card__hint">Shows the page owner's avatar, name and NIP-05.</small>`;
    return wrapEditable(block.id, 'profile-card', `${slot}${hint}`);
  }

  return slot;
}
