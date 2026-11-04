/**
 * DM tab persistence (Known/Unknown) shared by the two DM views.
 *
 * The active tab is session-persisted so back-navigation from a conversation
 * re-mounts the list in the tab the user came from. Leaving the DM section
 * entirely clears it — the next fresh entry always lands on Known.
 *
 * The clearing happens on the `router:navigate` event (previousPath outside
 * the DMs, see below): the primary-pane mounting path never destroys view
 * instances (factories return only `{ element }`), so destroy()-based
 * cleanup cannot be relied on there.
 */

const TAB_STORAGE_KEY = 'noornote_messages_tab';

export type DmTab = 'known' | 'unknown';

/** Tab to open the list with; falls back to Known when nothing is persisted. */
export function readInitialDmTab(): DmTab {
  try {
    return sessionStorage.getItem(TAB_STORAGE_KEY) === 'unknown'
      ? 'unknown'
      : 'known';
  } catch {
    return 'known';
  }
}

/** Persist a tab switch (list view only). */
export function persistDmTab(tab: DmTab): void {
  try {
    sessionStorage.setItem(TAB_STORAGE_KEY, tab);
  } catch {
    /* storage unavailable — tab simply resets on remount */
  }
}

/**
 * Clear the persisted tab when the DM section is left. Call from destroy():
 * the router has already switched to the destination path, so a destination
 * outside the DMs resets the tab while list ↔ conversation navigation keeps it.
 */
export function clearDmTabIfLeaving(currentPath: string): void {
  if (currentPath.startsWith('/messages')) return;
  try {
    sessionStorage.removeItem(TAB_STORAGE_KEY);
  } catch {
    /* storage unavailable — nothing persisted anyway */
  }
}

// Navigation watcher: clears the persisted tab whenever the DM section is
// left (covers the primary-pane path, whose views are never destroyed).
// Conversation navigation (/messages ↔ /messages/:pubkey) keeps the tab.
if (typeof window !== 'undefined') {
  window.addEventListener('router:navigate', (event: unknown) => {
    const detail = (
      event as CustomEvent<{ path?: string; previousPath?: string }>
    ).detail;
    if (
      detail?.previousPath?.startsWith('/messages') &&
      !detail.path?.startsWith('/messages')
    ) {
      try {
        sessionStorage.removeItem(TAB_STORAGE_KEY);
      } catch {
        /* storage unavailable — nothing persisted anyway */
      }
    }
  });
}
