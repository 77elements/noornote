/**
 * CurationSetItems - SNV section for NIP-51 article curation sets
 * (kind 30004, e.g. Zap Cooking Recipe Packs).
 *
 * Resolves the referenced addressable items (recipe = kind-30023 article)
 * and renders them as clickable rows below the card. This is the ONLY place
 * that fetches the referenced items — the feed/quote card (CurationSetRenderer)
 * stays light, so a quoted pack costs exactly one relay fetch.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import {
  parseCurationSetEvent,
  CURATION_SET_KIND,
} from '../../../helpers/parseCurationSet';
import { encodeNaddr } from '../../../services/NostrToolsAdapter';
import { getViewNavigationController } from '../../../services/ViewNavigationController';
import { escapeHtml } from '../../../helpers/escapeHtml';
import { ModuleLoader } from '../../../core/ModuleLoader';
import type { ArticlesModuleApi } from '../../../modules/articles/contracts';
import { UserProfileService } from '../../../services/UserProfileService';
import { diagLog } from '../../../services/DiagnosticLogger';

export async function mountCurationSetItems(
  event: NostrEvent,
  container: HTMLElement
): Promise<void> {
  if (event.kind !== CURATION_SET_KIND) return;

  const set = parseCurationSetEvent(event);
  if (set.itemRefs.length === 0) return;

  container.innerHTML = `
    <h2 class="curation-items__title">In this collection</h2>
    <div class="ui-list" data-role="curation-items"></div>
  `;
  const list = container.querySelector('[data-role="curation-items"]');
  if (!list) return;

  const loading = document.createElement('div');
  loading.className = 'ui-list__item pulsate';
  loading.textContent = 'Loading items…';
  list.appendChild(loading);

  const articlesApi =
    ModuleLoader.getInstance().getApi<ArticlesModuleApi>('articles');

  const rows = await Promise.all(
    set.itemRefs.map(async ref => {
      const naddr = encodeNaddr({
        kind: ref.kind,
        pubkey: ref.pubkey,
        identifier: ref.identifier,
        relays: ref.relay ? [ref.relay] : [],
      });
      let item: NostrEvent | null = null;
      try {
        item = (await articlesApi?.fetchAddressableEvent(naddr)) ?? null;
      } catch {
        /* unresolved — fall back to the coordinate slug */
      }
      return { ref, naddr, item };
    })
  );

  const resolved = rows.filter(r => r.item).length;
  diagLog('system', 'Curation set items resolved', {
    id: set.id,
    total: rows.length,
    resolved,
  });

  list.innerHTML = '';
  for (const row of rows) {
    list.appendChild(buildItemRow(row));
  }
}

function buildItemRow(row: {
  ref: { kind: number; pubkey: string; identifier: string };
  naddr: string;
  item: NostrEvent | null;
}): HTMLElement {
  const { naddr, item, ref } = row;
  const title =
    item?.tags.find(t => t[0] === 'title')?.[1] || ref.identifier || 'Untitled';
  const author = item
    ? UserProfileService.getInstance().getUsername(item.pubkey)
    : undefined;

  const el = document.createElement('div');
  el.className = 'ui-list__item ui-list__item--clickable';
  el.innerHTML = `
    <div class="curation-items__info">
      <span class="curation-items__name">${escapeHtml(title)}</span>
      ${author ? `<span class="curation-items__author">${escapeHtml(author)}</span>` : ''}
    </div>
    <svg width="18" height="18" aria-hidden="true"><use href="#icon-forward"/></svg>
  `;
  el.addEventListener('click', e => {
    getViewNavigationController().openView('single-note', naddr, e);
  });
  return el;
}
