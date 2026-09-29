/**
 * Shared editor chrome wiring for the form editors (Article, Video,
 * Marketplace listing): tab click handlers, accordion toggles, relay
 * selector and footer toolbar setup. All three editors wire the identical
 * blocks — this module holds them ONCE (jscpd H5 clone-budget
 * consolidation, 2026-09-29).
 */

import { setupTabClickHandlers } from '../../helpers/TabsHelper';
import { RelaySelector } from './RelaySelector';
import { PostEditorToolbar } from './PostEditorToolbar';

export function setupEditorChrome(options: {
  container: HTMLElement;
  relaySelector: RelaySelector | null;
  toolbar: PostEditorToolbar | null;
  onTabSwitch: (tabId: string) => void;
}): void {
  const { container, relaySelector, toolbar, onTabSwitch } = options;

  // Tab switching
  setupTabClickHandlers(container, onTabSwitch);

  // Accordion toggle
  container.querySelectorAll('.nn-ui-toggle__header').forEach(header => {
    header.addEventListener('click', () =>
      header.closest('.nn-ui-toggle')?.classList.toggle('open')
    );
  });

  // Relay selector
  const relaySelectorContainer = container.querySelector(
    '.post-note-relay-selector'
  );
  if (relaySelector && relaySelectorContainer) {
    relaySelector.setupEventListeners(relaySelectorContainer as HTMLElement);
  }

  // Footer toolbar (emoji, media)
  const toolbarContainer = container.querySelector('.post-note-toolbar');
  if (toolbar && toolbarContainer) {
    toolbar.setupEventListeners(toolbarContainer as HTMLElement);
  }
}

/** Create the shared relay selector used by all form editors. */
export function createEditorRelaySelector(options: {
  availableRelays: string[];
  selectedRelays: Set<string>;
  isTestMode: boolean;
  onChange: (selectedRelays: Set<string>) => void;
}): RelaySelector {
  return new RelaySelector({
    availableRelays: options.availableRelays,
    selectedRelays: options.selectedRelays,
    isTestMode: options.isTestMode,
    onChange: options.onChange,
  });
}
