import { AuthService } from '../../services/AuthService';
import { decodeNip19 } from '../../services/NostrToolsAdapter';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { ArticlesModuleApi } from '../../modules/articles/contracts';
import type { PostsModuleApi } from '../../modules/posts/contracts';
import { NoteUI } from '../../components/ui/NoteUI';
import { escapeHtml } from '../../helpers/escapeHtml';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

/**
 * Mount each `<div data-embed-mount data-nostr-ref="…">` slot inside the
 * given container with the resolved Nostr event rendered via NoteUI.
 *
 * Fire-and-forget per slot — embeds load in parallel, and a slot stays as
 * its loading skeleton if the user navigates away mid-fetch (we check
 * `isConnected` before writing). Used by both NospressView (in-app readonly
 * preview) and PublicNospressPage (public-facing site), so the resolution
 * rules stay consistent across the two surfaces.
 */
export function mountNospressEmbeds(container: HTMLElement): void {
  const slots = container.querySelectorAll<HTMLElement>('[data-embed-mount]');
  slots.forEach(slot => {
    const ref = slot.dataset.nostrRef ?? '';
    if (!ref.trim()) return;
    void resolveAndMount(slot, ref);
  });
}

async function resolveAndMount(slot: HTMLElement, nostrRef: string): Promise<void> {
  try {
    const cleaned = nostrRef.replace(/^nostr:/, '').trim();
    let event: NostrEvent | null = null;

    if (cleaned.startsWith('naddr1')) {
      const articlesApi = ModuleLoader.getInstance().getApi<ArticlesModuleApi>('articles');
      event = await articlesApi?.fetchAddressableEvent(cleaned) ?? null;
    } else {
      // nevent1 / note1 / raw 64-char hex → resolve to event id, then go through
      // NoteService so repeated embeds of the same note hit the LRU cache and
      // parallel fetches dedupe.
      let id: string | null = null;
      if (cleaned.startsWith('nevent1') || cleaned.startsWith('note1')) {
        const decoded = decodeNip19(cleaned);
        id = decoded.type === 'nevent'
          ? (decoded.data as { id: string }).id
          : decoded.type === 'note'
          ? (decoded.data as string)
          : null;
      } else if (/^[0-9a-fA-F]{64}$/.test(cleaned)) {
        id = cleaned.toLowerCase();
      }
      if (id) {
        const postsApi = ModuleLoader.getInstance().getApi<PostsModuleApi>('posts');
        event = await postsApi?.getNote(id) ?? null;
      }
    }

    if (!slot.isConnected) return;

    if (!event) {
      slot.innerHTML = `<p class="nospress-block-embed__error">Embed not found: ${escapeHtml(nostrRef)}</p>`;
      return;
    }

    const noteElement = NoteUI.createNoteElement(event, {
      collapsible: true,
      islFetchStats: true,
      isLoggedIn: AuthService.getInstance().getCurrentUser() !== null,
      depth: 1,
    });
    slot.innerHTML = '';
    slot.appendChild(noteElement);
  } catch (error) {
    console.error('Embed resolution failed:', error);
    if (slot.isConnected) {
      slot.innerHTML = `<p class="nospress-block-embed__error">Failed to load embed</p>`;
    }
  }
}
