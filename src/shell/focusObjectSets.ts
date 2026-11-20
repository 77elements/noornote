/**
 * Focus object sets (v2) — named bundles of visible objects.
 *
 * The settings-sidebar dropdown lists these; picking one applies it in ONE step:
 * every registry id not listed `visible` is hidden (the same machinery
 * as the per-object hide button — one save → one event → addon shutdown
 * diff + grid update + ED-b chips rebuild). The catalog is code-defined
 * (curated, meaningful bundles); the current state is never stored
 * separately — the dropdown derives "active" by exact match against the
 * live hidden set.
 */

import { FOCUS_DOMAINS } from './focusDomains';
import { loadHiddenObjectIds, saveHiddenObjectIds } from './hiddenObjectsStore';
import { _ } from '../i18n';
import { diagLog } from '../services/DiagnosticLogger';

export interface FocusObjectSet {
  id: string;
  label: string;
  /** Registry ids that stay visible — everything else is hidden. */
  visible: string[];
}

export const FOCUS_OBJECT_SETS: FocusObjectSet[] = [
  {
    id: 'social-minimal',
    label: _('Social Media (minimal)'),
    visible: ['social', 'follows', 'notifications', 'muted', 'profile'],
  },
  {
    id: 'everything',
    label: _('Everything'),
    // Full registry, computed — a future domain is included automatically.
    visible: FOCUS_DOMAINS.map(d => d.id),
  },
];

/** Hidden ids for a set: every registry id not listed visible. Locked
 * domains are filtered out by the store's sanitizer on save. */
export function hiddenIdsForSet(set: FocusObjectSet): string[] {
  const all = FOCUS_DOMAINS.map(d => d.id);
  return all.filter(id => !set.visible.includes(id));
}

/** The set whose application exactly equals the current hidden state. */
export function matchingObjectSet(
  hidden: readonly string[]
): FocusObjectSet | null {
  const key = [...hidden].sort().join(',');
  return (
    FOCUS_OBJECT_SETS.find(
      set => [...hiddenIdsForSet(set)].sort().join(',') === key
    ) ?? null
  );
}

/** Apply a set: hide everything not in its visible list. Idempotent. */
export function applyObjectSet(setId: string): string[] {
  const set = FOCUS_OBJECT_SETS.find(s => s.id === setId);
  if (!set) return loadHiddenObjectIds();
  const hidden = saveHiddenObjectIds(hiddenIdsForSet(set));
  diagLog('system', 'focus_object_set_applied', {
    setId,
    hiddenCount: hidden.length,
  });
  return hidden;
}
