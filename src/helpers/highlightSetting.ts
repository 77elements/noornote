/**
 * Highlight visibility setting.
 *
 * A "highlight" here is a NIP-84 highlight (kind 9802) whose source is an
 * external web URL (an `r` tag, or an explicit `source`-marker tag with
 * an http(s) value) — the browser-extension pattern of quoting article
 * passages from arbitrary websites into Nostr. Some users quote nearly every
 * paragraph of an article this way, flooding timelines with highlight cards.
 *
 * Two independent controls hide these:
 *  - Global switch (Settings → UI): hides everyone's highlights
 *  - Per-user override (ProfileView checkbox): hides that one author's
 *
 * Pure reposts (kind 6/16) of a highlight count as the same
 * content and are hidden by FeedOrchestrator under the same conditions.
 *
 * The user's own highlights are always visible. Highlights whose source is a
 * Nostr note or article (e/a tags) are never affected here —
 * do not confuse with quoted reposts (kind 1 + q-tag).
 */

import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../services/PerAccountLocalStorage';

/** NIP-84 source resolution priority, shared shape with HighlightProcessor. */
function resolveSourceTag(tags: string[][]): string[] | null {
  const explicit = tags.find(t => t[2] === 'source');
  if (explicit) return explicit;
  const eTag = tags.find(t => t[0] === 'e');
  if (eTag) return eTag;
  const aTag = tags.find(t => t[0] === 'a');
  if (aTag) return aTag;
  const rTag = tags.find(t => t[0] === 'r');
  return rTag ?? null;
}

/**
 * True when the event is a kind 9802 highlight quoting an external website
 * (resolved source is an http(s) URL). Nostr-internal highlights (source is
 * a note or article) return false.
 */
export function isExternalHighlight(event: {
  kind?: number;
  tags?: string[][];
}): boolean {
  if (event.kind !== 9802) return false;
  const source = resolveSourceTag(event.tags ?? []);
  if (!source) return false;
  return /^https?:\/\//i.test(source[1] ?? '');
}

// ── Global switch ─────────────────────────────────────────────

export function isHideHighlightsEnabled(): boolean {
  return PerAccountLocalStorage.getInstance().get<boolean>(
    StorageKeys.HIDE_HIGHLIGHTS,
    false
  );
}

export function setHideHighlightsEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(
    StorageKeys.HIDE_HIGHLIGHTS,
    enabled
  );
}

// ── Per-user overrides ────────────────────────────────────────

/** Map of author pubkeys whose highlights are hidden. */
export function getHiddenHighlightAuthors(): Record<string, boolean> {
  return PerAccountLocalStorage.getInstance().get<Record<string, boolean>>(
    StorageKeys.HIDE_HIGHLIGHTS_USERS,
    {}
  );
}

export function isHighlightHiddenFor(pubkey: string): boolean {
  return getHiddenHighlightAuthors()[pubkey] === true;
}

export function setHighlightHiddenFor(pubkey: string, hidden: boolean): void {
  const store = PerAccountLocalStorage.getInstance();
  const map = store.get<Record<string, boolean>>(
    StorageKeys.HIDE_HIGHLIGHTS_USERS,
    {}
  );
  if (hidden) {
    map[pubkey] = true;
  } else {
    delete map[pubkey];
  }
  store.set(StorageKeys.HIDE_HIGHLIGHTS_USERS, map);
}
