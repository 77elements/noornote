/**
 * Focus surface: Recipes object (v2).
 *
 * Recipes are kind-30023 articles carrying the `zapcooking` discovery tag
 * (helpers/recipeTemplate.ts) from the user's follows — the v1 scc tab
 * feed (SccRecipeFeed) reused as the object's list, self-contained with
 * its own batching/dedup/infinite scroll. Card clicks navigate to
 * `/article/:naddr` — the stage re-derives the state from the URL and
 * morphs to the Articles object. The feed's scc scroller degrades to
 * natural height here (percentage height against the auto-height flow
 * root) — the focus column is the scroll container.
 */

import { _ } from '../i18n';
import type { FocusDomainSurface } from './focusDomains';

export const focusRecipesSurface = async (): Promise<FocusDomainSurface> => {
  const { SccRecipeFeed } = await import(
    '../components/layout/partials/SccRecipeFeed'
  );
  let feed: { destroy(): void } | null = null;

  // .view-content root (the slot's height:100% child) so the flow-root
  // clearance rule (`.ui--focus .view-content .focus-flow-root`) matches.
  const container = document.createElement('div');
  container.className = 'view-content focus-recipes-object';
  container.innerHTML = `
      <div class="back-padder focus-flow-root">
        <h1>${_('Recipes')}</h1>
      </div>
    `;

  const flowRoot = container.querySelector('.focus-flow-root');
  if (flowRoot) feed = new SccRecipeFeed(flowRoot as HTMLElement);

  return {
    attach: slot => {
      slot.appendChild(container);
    },
    detach: () => container.remove(),
    view: {
      destroy(): void {
        feed?.destroy();
        feed = null;
        container.remove();
      },
    },
  };
};
