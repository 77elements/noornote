import { ProfileArticlesCarousel } from '../../components/profile/ProfileArticlesCarousel';
import { decodeNip19 } from '../../services/NostrToolsAdapter';

/**
 * Mount each `<div data-articles-list-mount>` slot with a
 * `ProfileArticlesCarousel` of the author's NIP-23 long-form articles.
 *
 * Reuses the same component the ProfileView already uses, so the visual
 * stays consistent across the two surfaces (PV carousel and NosPress
 * articles-list block). `data-pubkey` overrides; absent = `ownerPubkey`.
 *
 * Returns the created instances so the caller can `destroy()` them on
 * unmount / re-render.
 */
export function mountNospressArticlesLists(
  container: HTMLElement,
  opts: { ownerPubkey: string }
): ProfileArticlesCarousel[] {
  const slots = container.querySelectorAll<HTMLElement>('[data-articles-list-mount]');
  const instances: ProfileArticlesCarousel[] = [];
  slots.forEach(slot => {
    const pubkey = resolvePubkey(slot.dataset.pubkey, opts.ownerPubkey);
    if (!pubkey) {
      slot.innerHTML = `<p class="nospress-block-articles-list__empty">No author resolved.</p>`;
      return;
    }
    const carousel = new ProfileArticlesCarousel(pubkey);
    instances.push(carousel);
    slot.innerHTML = '';
    slot.appendChild(carousel.getElement());
    void carousel.render();
  });
  return instances;
}

function resolvePubkey(raw: string | undefined, fallback: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return fallback;
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  try {
    const decoded = decodeNip19(trimmed);
    if (decoded.type === 'npub') return decoded.data as string;
  } catch { /* fall through */ }
  return fallback;
}
