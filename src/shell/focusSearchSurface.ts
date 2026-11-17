/**
 * Focus surface: Search object (v2).
 *
 * Search is its own object/circle: an inline search input feeds the
 * existing global-search pipeline — GlobalSearchView listens on
 * `globalSearch:start` and renders the note results into its own
 * container. The v1 aside-tab plumbing degrades to no-ops when the v1
 * sidebar is absent (it queries `#sidebar-tabs` / `.secondary-content`
 * only when they exist). No search-logic changes: notes via the search
 * module (NIP-50 / local), users via the same `searchUsers` API the
 * Spotlight uses. Result clicks navigate via the Router
 * (`/note/:nevent`, `/profile/:npub`, `/messages/:npub`) — the stage
 * re-derives the state from the URL and morphs to the owning object
 * (SNV in Social, PV in Profile, DMV in Messages).
 */

import { Router } from '../services/Router';
import { ModuleLoader } from '../core/ModuleLoader';
import { TypedEventBus } from '../core/TypedEventBus';
import type { SearchModuleApi } from '../modules/search/contracts';
import type { UserSearchResult } from '../services/UserSearchService';
import { renderUserSearchRows } from '../components/user-search/userSearchRows';
import { hexToNpub } from '../helpers/nip19';
import { _ } from '../i18n';
import type { FocusDomainSurface } from './focusDomains';

export const focusSearchSurface = async (): Promise<FocusDomainSurface> => {
  const { GlobalSearchView } = await import(
    '../components/search/GlobalSearchView'
  );
  const searchView = new GlobalSearchView();

  const container = document.createElement('div');
  container.className = 'view-content focus-search-object';
  container.innerHTML = `
      <div class="back-padder focus-flow-root">
        <h1>${_('Search')}</h1>
        <div class="focus-search-object__bar">
          <input
            type="search"
            data-el="focus-search-input"
            class="focus-search-object__input"
            placeholder="${_('Search notes, users and hashtags…')}"
            autocomplete="off"
          />
        </div>
        <div class="focus-search-object__users" data-el="focus-search-users"></div>
        <div class="focus-search-object__results" data-el="focus-search-results"></div>
      </div>
    `;

  const input = container.querySelector(
    '[data-el=focus-search-input]'
  ) as HTMLInputElement | null;
  const resultsSlot = container.querySelector(
    '[data-el=focus-search-results]'
  ) as HTMLElement | null;
  const usersSlot = container.querySelector(
    '[data-el=focus-search-users]'
  ) as HTMLElement | null;

  if (resultsSlot) resultsSlot.appendChild(searchView.getElement());

  let searchApi: SearchModuleApi | null = null;
  let userAbort: AbortController | null = null;
  let userResults: UserSearchResult[] = [];
  let isSearchingUsers = false;

  const renderUsers = () => {
    if (!usersSlot) return;
    const query = input?.value.trim() ?? '';
    if (query.length < 2 || query.startsWith('#')) {
      usersSlot.innerHTML = '';
      return;
    }
    usersSlot.innerHTML = `
        <div class="search-spotlight__user-section">
          <div class="search-spotlight__user-header">${_('Users')}${isSearchingUsers ? ` <span class="pulsate">${_('(loading…)')}</span>` : ''}</div>
          ${renderUserSearchRows(userResults)}
        </div>
      `;
    usersSlot.querySelectorAll('.search-spotlight__user-item').forEach(item => {
      item.addEventListener('click', () => {
        const pubkey = item.getAttribute('data-pubkey');
        if (!pubkey) return;
        const npub = hexToNpub(pubkey);
        if (npub) Router.getInstance().navigate(`/profile/${npub}`);
      });
    });
  };

  /** Same user-search flow the Spotlight runs (local + remote). */
  const performUserSearch = (query: string) => {
    if (!searchApi) {
      searchApi = ModuleLoader.getInstance().getApi<SearchModuleApi>('search');
    }
    userAbort?.abort();
    userAbort =
      searchApi?.searchUsers(query, {
        onLocalResults: results => {
          userResults = results;
          renderUsers();
        },
        onRemoteResults: results => {
          const existing = new Set(userResults.map(r => r.pubkey));
          userResults = [
            ...userResults,
            ...results.filter(r => !existing.has(r.pubkey)),
          ];
          renderUsers();
        },
        onComplete: () => {
          isSearchingUsers = false;
          renderUsers();
        },
      }) ?? null;
  };

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  const runSearch = () => {
    const query = input?.value.trim() ?? '';
    if (query.length < 2) {
      userResults = [];
      renderUsers();
      return;
    }
    // Direct identifiers navigate straight to their object (the
    // Spotlight's route resolution, in its smallest form).
    if (/^(npub1|nprofile1)/.test(query)) {
      Router.getInstance().navigate(`/profile/${query}`);
      return;
    }
    if (/^(nevent1|note1|naddr1)/.test(query)) {
      Router.getInstance().navigate(`/note/${query}`);
      return;
    }
    // Hashtag queries run the hashtag flow (special title + subscribe
    // button in the results view); everything else is a global search.
    const isHashtag = query.startsWith('#');
    TypedEventBus.getInstance().emit(
      isHashtag ? 'hashtagSearch:start' : 'globalSearch:start',
      isHashtag ? { hashtag: query.slice(1) } : { query }
    );
    userResults = [];
    isSearchingUsers = !isHashtag;
    renderUsers();
    if (isSearchingUsers) performUserSearch(query);
  };

  input?.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSearch, 450);
  });
  input?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      clearTimeout(debounceTimer);
      runSearch();
    }
  });

  return {
    attach: slot => {
      slot.appendChild(container);
      // .tab-content is display:none by default (molecules/_tabs.scss) —
      // the v1 tab plumbing adds --active on search start; without the
      // v1 sidebar make the container visible from the start.
      searchView.getElement().classList.add('tab-content--active');
      // Deep link: /search?q=<term> (hashtag-subscriptions Search button,
      // external links). The term was captured in main.ts — Router boot
      // rewrites the URL without the query. '#' terms run the hashtag flow.
      const q = window.__noornote_search_param?.trim();
      if (input && q) {
        delete window.__noornote_search_param;
        input.value = q;
        runSearch();
      }
      input?.focus();
    },
    detach: () => container.remove(),
    view: {
      destroy(): void {
        clearTimeout(debounceTimer);
        userAbort?.abort();
        userAbort = null;
        searchView.destroy();
        container.remove();
      },
    },
  };
};
