/**
 * Shared Follow Pack member-list renderer.
 *
 * Renders a pack's members as a `ui-list` with per-user Follow/Unfollow
 * buttons. Used by both FollowPackDetailView (always-on basic view) and
 * the Follow Packs addon's FollowPackManager — single source of truth for
 * member-row markup and follow-toggle behavior.
 *
 * Follow/Unfollow writes only to local storage (list state). Syncing to
 * relays is driven by the user's normal list-save flow and is independent
 * of this helper.
 */

import type { FollowPack } from '../../helpers/parseFollowPack';
import { UserProfileService } from '../../services/UserProfileService';
import { Router } from '../../services/Router';
import { hexToNpub } from '../../helpers/nip19';
import { npubToUsername } from '../../helpers/npubToUsername';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { sortMemberRowsByActivity } from './memberActivitySort';

export async function renderFollowPackMembers(
  pack: FollowPack,
  container: HTMLElement
): Promise<void> {
  const profileService = UserProfileService.getInstance();
  const [profiles, { getFollowItems, setFollowItems }] = await Promise.all([
    profileService.getUserProfiles(pack.userPubkeys),
    import('../../lists/follows')
  ]);

  const followedPubkeys = new Set(getFollowItems().map(f => f.pubkey));

  container.innerHTML = '';

  const list = document.createElement('div');
  list.className = 'ui-list';

  pack.userPubkeys.forEach(pubkey => {
    const profile = profiles.get(pubkey);
    const npub = hexToNpub(pubkey) || '';
    const name = profile?.display_name || profile?.name || npubToUsername(npub) || npub.slice(0, 12);
    const picture = profile?.picture || '';
    const isFollowing = followedPubkeys.has(pubkey);

    const item = document.createElement('div');
    item.className = 'ui-list__item follow-packs__member-item';
    item.dataset.pubkey = pubkey;
    item.innerHTML = `
      <div class="follow-packs__member-content">
        <div class="follow-packs__member-avatar">
          <img class="profile-pic profile-pic--medium" src="${escapeHtmlAttr(picture)}" alt="${escapeHtmlAttr(name)}" />
        </div>
        <div class="follow-packs__member-info">
          <div class="follow-packs__member-name">${escapeHtml(name)}</div>
          <div class="follow-packs__member-activity" data-activity></div>
        </div>
      </div>
      <button class="follow-packs__member-action-btn btn ${isFollowing ? 'btn--passive ' : ''}btn--medium"
              data-pubkey="${pubkey}">${isFollowing ? 'Unfollow' : 'Follow'}</button>
    `;

    item.querySelector('.follow-packs__member-content')?.addEventListener('click', () => {
      if (npub) Router.getInstance().navigate(`/profile/${npub}`);
    });

    const actionBtn = item.querySelector('.follow-packs__member-action-btn') as HTMLButtonElement;
    actionBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const currentFollows = getFollowItems();
      const alreadyFollowing = currentFollows.some(f => f.pubkey === pubkey);

      if (alreadyFollowing) {
        setFollowItems(currentFollows.filter(f => f.pubkey !== pubkey));
        actionBtn.textContent = 'Follow';
        actionBtn.classList.remove('btn--passive');
      } else {
        setFollowItems([
          ...currentFollows,
          { id: pubkey, pubkey, relay: '', addedAt: Math.floor(Date.now() / 1000) }
        ]);
        actionBtn.textContent = 'Unfollow';
        actionBtn.classList.add('btn--passive');
      }
    });

    list.appendChild(item);
  });

  container.appendChild(list);

  // Progressive: list is shown in pack order first, then re-sorted so the most
  // recently active members rise to the top. Non-blocking — a slow/failed
  // activity fetch never holds up the list.
  void sortMemberRowsByActivity(list, pack.userPubkeys).catch(() => { /* non-fatal */ });
}
