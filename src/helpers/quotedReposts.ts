/**
 * Shared "quoted reposts + threaded replies" plumbing for the SNV reply
 * renderers (RepliesRenderer + ThreadManager). Both fetch/merge/render the
 * same way — this module holds that logic ONCE so the two views cannot
 * drift apart (jscpd H5 clone-budget consolidation, 2026-09-29).
 */

import { fetchNostrEvents } from '../services/FetchNostrEvents';
import { type ThreadNode } from './threadTree';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

/**
 * Build the "X quoted this …" card for an embedded quoted repost: content
 * stripped of the quoted reference, clickable header link (SPA routing),
 * NoteUI preview element, appended to `container`. Returns the wrapper
 * element. The header markup and the content-strip pattern differ between
 * the reply view (quoted note) and the thread view (repost) — passed in.
 */
export async function renderQuotedNoteCard(opts: {
  quoteEvent: NostrEvent;
  container: Element;
  /** Strip these nostr: references from the quoted content. */
  stripPattern: RegExp;
  /** Header inner HTML; receives username + nevent. */
  headerHtml: (username: string, nevent: string) => string;
  /** Profile lookup (service is owned by the caller). */
  getUsername: (pubkey: string) => Promise<string | null>;
}): Promise<HTMLElement | null> {
  const quoteEventId = opts.quoteEvent.id;
  if (!quoteEventId) return null;

  const cleanedEvent = {
    ...opts.quoteEvent,
    content: opts.quoteEvent.content.replace(opts.stripPattern, '').trim(),
  };

  const quoteWrapper = document.createElement('div');
  quoteWrapper.className = 'snv-quoted-repost';
  quoteWrapper.dataset.eventId = quoteEventId;

  const username =
    (await opts.getUsername(opts.quoteEvent.pubkey)) ?? 'Anonymous';
  // Dynamic imports: this helper module is also loaded by unit tests (node
  // env) where Router / encodeNeventWithHints / NoteUI pull in the
  // UserHoverCard → lists/follows chain and boot services at module scope.
  const [{ encodeNeventWithHints }, { Router }, { NoteUI }] = await Promise.all(
    [
      import('./encodeNeventWithHints'),
      import('../services/Router'),
      import('../components/ui/NoteUI'),
    ]
  );
  const nevent = encodeNeventWithHints(opts.quoteEvent);

  const quoteHeader = document.createElement('div');
  quoteHeader.className = 'snv-quoted-repost__header';
  quoteHeader.innerHTML = opts.headerHtml(username, nevent);
  const link = quoteHeader.querySelector(
    '.snv-quoted-repost__link'
  ) as HTMLAnchorElement | null;
  link?.addEventListener('click', e => {
    e.preventDefault();
    void Router.getInstance().navigate(`/note/${nevent}`);
  });

  // Use NoteUI to render the quote (disable auto-setup — will be set up
  // manually after DOM insertion by the caller if needed).
  const noteElement = NoteUI.createNoteElement(cleanedEvent, {
    collapsible: false,
    islFetchStats: false,
    isLoggedIn: false,
    headerSize: 'small',
    depth: 0,
  });

  // Assemble: header + note
  quoteWrapper.appendChild(quoteHeader);
  quoteWrapper.appendChild(noteElement);
  opts.container.appendChild(quoteWrapper);
  return quoteWrapper;
}

/**
 * Fetch quoted reposts (kind 1 or 6 referencing this note via NIP-18 'q',
 * addressable '#a', or legacy e-tag-mention + nostr: URI in content).
 * Candidates are deduped by event id.
 */
export async function fetchQuotedRepostCandidates(
  relays: string[],
  noteId: string
): Promise<NostrEvent[]> {
  // Addressable events (NIP-33 kinds 30000–39999) are referenced via #a,
  // not #e — passing a coordinate through the #e filter is rejected by NDK
  // as "not a valid 64-char hex string".
  const isAddressable = noteId.includes(':');

  // Two relay queries in parallel: NIP-18 q-tag AND legacy e-tag-with-mention
  // (Primal-iOS pre-NIP-18 pattern). Tag-OR can't be expressed in one filter.
  const fetches: Array<Promise<{ events: NostrEvent[] }>> = [
    fetchNostrEvents({
      relays,
      kinds: [1, 6],
      tags: { q: [noteId] },
      limit: 100,
    }),
  ];
  if (isAddressable) {
    fetches.push(
      fetchNostrEvents({
        relays,
        kinds: [1, 6],
        tags: { a: [noteId] },
        limit: 100,
      })
    );
  } else {
    fetches.push(
      fetchNostrEvents({
        relays,
        kinds: [1],
        tags: { e: [noteId] },
        limit: 100,
      })
    );
  }
  const results = await Promise.all(fetches);
  const qTagResult = results[0]!;
  const eTagResult = results[1]!;

  const byId = new Map<string, NostrEvent>();
  for (const ev of [...qTagResult.events, ...eTagResult.events]) {
    if (ev.id) byId.set(ev.id, ev);
  }

  return Array.from(byId.values()).filter(event => {
    const hasContent = event.content.trim().length > 0;
    if (!hasContent) return false;

    if (event.tags.some(tag => tag[0] === 'q' && tag[1] === noteId))
      return true;

    if (isAddressable) {
      // Addressable: match via #a tag
      return event.tags.some(tag => tag[0] === 'a' && tag[1] === noteId);
    }

    const eTags = event.tags.filter(tag => tag[0] === 'e' && tag[1] === noteId);
    return (
      eTags.some(tag => tag[3] === 'mention') &&
      /nostr:(nevent1|note1|naddr1)/.test(event.content)
    );
  });
}

/** A timeline entry in a thread view: a threaded reply or a quoted repost. */
export type ThreadComment =
  | { type: 'reply'; node: ThreadNode; timestamp: number }
  | { type: 'quote'; event: NostrEvent; timestamp: number };

/**
 * Merge threaded replies + quoted reposts into one chronological list
 * (oldest first).
 */
export function mergeChronologicalComments(
  threadTree: ThreadNode[],
  quotedReposts: NostrEvent[]
): ThreadComment[] {
  return [
    ...threadTree.map(node => ({
      type: 'reply' as const,
      node,
      timestamp: node.event.created_at,
    })),
    ...quotedReposts.map(event => ({
      type: 'quote' as const,
      event,
      timestamp: event.created_at,
    })),
  ].sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Whether this comment is a DIRECT (top-level) reply by the note's author.
 */
export function isAuthorTopLevelReply(
  comment: ThreadComment,
  noteAuthor: string | undefined
): boolean {
  return (
    !!noteAuthor &&
    comment.type === 'reply' &&
    comment.node.depth === 0 &&
    comment.node.event.pubkey === noteAuthor
  );
}

/**
 * Twitter-style author pin: the note author's DIRECT (top-level) replies are
 * moved to the top of the comment list (chronological among themselves), so a
 * late correction isn't buried under dozens of later replies. Applies for
 * EVERY viewer — Nostr notes are immutable, so the author's only way to
 * correct an existing note is a self-reply, and followers must see it first.
 */
export function pinAuthorReplies(
  comments: ThreadComment[],
  noteAuthor: string | undefined
): ThreadComment[] {
  const pinned = comments.filter(c => isAuthorTopLevelReply(c, noteAuthor));
  if (pinned.length === 0) return comments;
  return [...pinned, ...comments.filter(c => !pinned.includes(c))];
}

/**
 * Render a thread node recursively (depth-first, pre-order) into the
 * container. `createReplyElement` builds the DOM element for one event at
 * the given depth.
 */
export function renderThreadedReplyNodes(
  node: ThreadNode,
  container: Element,
  createReplyElement: (event: NostrEvent, depth: number) => HTMLElement
): void {
  container.appendChild(createReplyElement(node.event, node.depth));

  // Recursively render children
  node.children.forEach(childNode => {
    renderThreadedReplyNodes(childNode, container, createReplyElement);
  });
}
