/**
 * Readable plain-text form of NIP-29 group chat message content (kind 9).
 *
 * Group messages often embed NIP-21 references (`nostr:nevent1…`, `nostr:npub1…`)
 * as raw bech32 blobs. Rendering them verbatim floods the UI with unreadable
 * strings, so they are replaced with short bracketed labels. Used by the
 * kind-9 fallback card (UnsupportedKindRenderer) and the notification preview.
 */

const NIP21_RE = /nostr:(note1[0-9a-z]+|nevent1[0-9a-z]+|naddr1[0-9a-z]+|npub1[0-9a-z]+|nprofile1[0-9a-z]+)/g;

export function formatGroupChatContent(content: string): string {
  return content
    .replace(NIP21_RE, (_match, kind: string) => {
      if (kind.startsWith('npub') || kind.startsWith('nprofile')) return '@user';
      if (kind.startsWith('naddr')) return '[linked event]';
      return '[shared note]';
    })
    .replace(/\s+/g, ' ')
    .trim();
}
