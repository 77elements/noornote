/**
 * Recipe publishing helpers — zap.cooking-compatible recipe articles.
 *
 * Recipes on zap.cooking are regular NIP-23 articles (kind 30023) with two
 * de-facto conventions (no NIP — verified against zapcooking/frontend
 * `src/lib/parser.ts` / `src/lib/consts.ts`):
 *
 * 1. The discovery tag `t: zapcooking` (legacy clients used `nostrcooking`)
 *    — recipe clients list articles by that tag filter.
 * 2. A structured Markdown template the recipe reader parses back into
 *    fields: `## Details` (⏲️/🍳/🍽️ bullet lines), `## Ingredients`
 *    (`- ` bullets), `## Directions` (strictly consecutive `1.` `2.` `3.`),
 *    plus optional `## Chef's notes` and `## Additional Resources`.
 *
 * @used-by ArticleEditorView (recipe mode)
 */

export const RECIPE_DISCOVERY_TAG = 'zapcooking';

/** Skeleton mirroring zap.cooking's `createMarkdown()` output. */
export const RECIPE_TEMPLATE_MARKDOWN = `## Details

- ⏲️ Prep time: 
- 🍳 Cook time: 
- 🍽️ Servings: 

## Ingredients

- 

## Directions

1. 
`;

/** Small curated subset of zap.cooking's tag taxonomy for quick adding. */
export const RECIPE_TOPIC_SUGGESTIONS: readonly string[] = [
  'Easy',
  'Quick',
  'Breakfast',
  'Lunch',
  'Dessert',
  'Snack',
  'Vegan',
  'Keto',
  'Healthy',
  'Gluten Free',
  'Spicy',
  'German',
  'Italian',
  'Asian',
  'American',
  'Mediterranean',
  'Pasta',
  'Pizza',
  'Soup',
  'Salad',
  'Bread',
  'Cake',
  'Chicken',
  'Beef',
  'Fish',
];

function hasSection(content: string, heading: string): boolean {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, 'im');
  return re.test(content);
}

/** True when content carries both a Ingredients and a Directions section. */
export function hasRecipeTemplate(content: string): boolean {
  return (
    hasSection(content, 'Ingredients') && hasSection(content, 'Directions')
  );
}

/**
 * Recipe-template sections missing from the content ('' → both missing).
 * Soft-gate only: callers warn, never block.
 */
export function missingRecipeSections(content: string): string[] {
  const missing: string[] = [];
  if (!hasSection(content, 'Ingredients')) missing.push('Ingredients');
  if (!hasSection(content, 'Directions')) missing.push('Directions');
  return missing;
}
