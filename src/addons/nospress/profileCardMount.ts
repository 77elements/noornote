import { UserIdentity } from '../../components/shared/UserIdentity';

/**
 * Mount each `<div data-profile-card-mount data-pubkey?="…">` slot inside
 * the given container with a `UserIdentity` component (avatar + display
 * name + NIP-05 handle, clickable → /profile/{npub}).
 *
 * `data-pubkey` overrides; absent = default to `ownerPubkey` (= the page
 * owner). Used by both NospressView (in-app readonly preview) and
 * PublicNospressPage (public-facing site) so the visual stays consistent.
 *
 * Returns the created instances so the caller can `destroy()` them on
 * unmount / re-render — UserIdentity holds a profile-update subscription.
 */
export function mountNospressProfileCards(
  container: HTMLElement,
  opts: { ownerPubkey: string }
): UserIdentity[] {
  const slots = container.querySelectorAll<HTMLElement>('[data-profile-card-mount]');
  const instances: UserIdentity[] = [];
  slots.forEach(slot => {
    const pubkey = (slot.dataset.pubkey || opts.ownerPubkey || '').trim();
    if (!pubkey) return;
    const ui = new UserIdentity({
      pubkey,
      size: 'large',
      showAvatar: true,
      showUsername: true,
      showHandle: true,
      enableHoverCard: false,
      clickable: true,
    });
    slot.innerHTML = '';
    slot.appendChild(ui.getElement());
    instances.push(ui);
  });
  return instances;
}
