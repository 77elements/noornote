/**
 * Hidden objects (v2) — persistence + event emission.
 *
 * Per-account local storage (same pattern as the circle order), changes
 * emit 'focus:objects-hidden-changed' so the stage, the ED-b panel and
 * the seam react immediately. Pure validation lives in hiddenObjects.ts;
 * this module wires it to the registry + storage.
 */

import { FOCUS_DOMAINS } from './focusDomains';
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../services/PerAccountLocalStorage';
import { TypedEventBus } from '../core/TypedEventBus';
import { sanitizeHiddenIds } from './focusDependencyGraph';

/** The full registry id list — the graph module stays pure. */
const ALL_DOMAIN_IDS = FOCUS_DOMAINS.map(d => d.id);

/** The sanitized persisted hidden set (fresh read — no stale cache). */
export function loadHiddenObjectIds(): string[] {
  const stored = PerAccountLocalStorage.getInstance().get<unknown>(
    StorageKeys.FOCUS_UI_HIDDEN_OBJECTS,
    null
  );
  return sanitizeHiddenIds(ALL_DOMAIN_IDS, stored);
}

/** Cheap membership probe on the fresh persisted set. */
export function isDomainHidden(id: string): boolean {
  return loadHiddenObjectIds().includes(id);
}

/**
 * Persist a new hidden set (sanitized) and announce it. The stage listens
 * and re-renders the grid optimistically; the ED-b panel rebuilds its
 * chips. Returns the effective set.
 */
export function saveHiddenObjectIds(ids: readonly string[]): string[] {
  const hidden = sanitizeHiddenIds(ALL_DOMAIN_IDS, ids);
  PerAccountLocalStorage.getInstance().set(
    StorageKeys.FOCUS_UI_HIDDEN_OBJECTS,
    hidden
  );
  TypedEventBus.getInstance().emit('focus:objects-hidden-changed', {
    hidden,
  });
  return hidden;
}

/** Hide one object (idempotent). Returns the effective set. */
export function hideObject(id: string): string[] {
  const current = loadHiddenObjectIds();
  if (current.includes(id)) return current;
  return saveHiddenObjectIds([...current, id]);
}

/** Unhide one object (idempotent). Returns the effective set. */
export function unhideObject(id: string): string[] {
  const current = loadHiddenObjectIds();
  if (!current.includes(id)) return current;
  return saveHiddenObjectIds(current.filter(x => x !== id));
}
