/**
 * Tests for recipe publishing helpers (zap.cooking-compatible recipe
 * articles: kind 30023 + t:zapcooking + structured Markdown template).
 */

import { describe, it, expect } from 'vitest';
import {
  RECIPE_DISCOVERY_TAG,
  RECIPE_TEMPLATE_MARKDOWN,
  hasRecipeTemplate,
  missingRecipeSections,
} from './recipeTemplate';

describe('recipeTemplate', () => {
  it('template itself satisfies the section check', () => {
    expect(hasRecipeTemplate(RECIPE_TEMPLATE_MARKDOWN)).toBe(true);
    expect(missingRecipeSections(RECIPE_TEMPLATE_MARKDOWN)).toEqual([]);
  });

  it('detects sections case-insensitively', () => {
    expect(
      hasRecipeTemplate(
        'some intro\n\n## ingredients\n\n- flour\n\n## directions\n\n1. mix'
      )
    ).toBe(true);
  });

  it('reports missing sections', () => {
    expect(missingRecipeSections('just text')).toEqual([
      'Ingredients',
      'Directions',
    ]);
    expect(missingRecipeSections('## Ingredients\n\n- flour')).toEqual([
      'Directions',
    ]);
    expect(missingRecipeSections('## Directions\n\n1. bake')).toEqual([
      'Ingredients',
    ]);
  });

  it('does not match plain-text mentions of the words', () => {
    expect(hasRecipeTemplate('the Ingredients and Directions are below')).toBe(
      false
    );
  });

  it('discovery tag constant matches the zap.cooking filter tag', () => {
    expect(RECIPE_DISCOVERY_TAG).toBe('zapcooking');
  });
});
