import type { NostrEvent } from '@nostr-dev-kit/ndk';
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../services/PerAccountLocalStorage';

const STORAGE_KEY = 'noornote_content_word_filter_enabled';

export function isContentWordFilterEnabled(): boolean {
  const perAccount = PerAccountLocalStorage.getInstance().get<boolean | null>(
    StorageKeys.CONTENT_WORD_FILTER_ENABLED,
    null
  );
  if (perAccount !== null) return perAccount;
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function setContentWordFilterEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(
    StorageKeys.CONTENT_WORD_FILTER_ENABLED,
    enabled
  );
  localStorage.setItem(STORAGE_KEY, 'false');
}

export function getFilterWords(): string[] {
  return PerAccountLocalStorage.getInstance().get<string[]>(
    StorageKeys.CONTENT_WORD_FILTER_WORDS,
    []
  );
}

export function setFilterWords(words: string[]): void {
  PerAccountLocalStorage.getInstance().set(
    StorageKeys.CONTENT_WORD_FILTER_WORDS,
    words
  );
}

/**
 * Filter events whose content matches any blocked word (case-insensitive substring).
 * For Kind 6 (reposts), parses embedded JSON to check original note content.
 * Skips filtering when addon is disabled or word list is empty.
 */
export function filterContentWords(events: NostrEvent[]): NostrEvent[] {
  if (!isContentWordFilterEnabled()) return events;

  const words = getFilterWords();
  if (words.length === 0) return events;

  return events.filter(event => {
    const contentToCheck = getContentToCheck(event);
    if (!contentToCheck) return true;

    const lowerContent = contentToCheck.toLowerCase();
    return !words.some(word => lowerContent.includes(word));
  });
}

/**
 * Extract the text content to check against the word filter.
 * For Kind 6 (reposts): parse embedded JSON to get original note content.
 */
function getContentToCheck(event: NostrEvent): string | null {
  if (!event.content) return null;

  if (event.kind === 6 || event.kind === 16) {
    try {
      // kind:6/16 repost embeds the original note (relay-controlled)
      const original = JSON.parse(event.content) as {
        content?: unknown;
      } | null;
      return typeof original?.content === 'string' ? original.content : null;
    } catch {
      return null;
    }
  }

  return event.content;
}
