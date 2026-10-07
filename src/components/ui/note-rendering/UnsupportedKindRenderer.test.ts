// @vitest-environment jsdom
/**
 * Tests for the unsupported-kind fallback card and NIP-5A nsite manifests.
 *
 * 1. Nsite manifests (kind 15128 root / kind 35128 named) route to the
 *    NsiteRenderer card (title + gateway link), never into the generic
 *    "Unsupported event kind" fallback.
 * 2. Kind 35128 is shared with Satellite Earth site settings — only the
 *    NIP-5A-mandatory `path` tags tell the two specs apart.
 * 3. Generic fallback cards carry the minimal 3-dot menu (copy ids / raw
 *    JSON) and mousedown-navigate to SNV like supported cards do.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { hexToNpub } from '../../../helpers/nip19';
import { encodeNevent } from '../../../services/NostrToolsAdapter';
import type { ProcessedNote } from '../types/NoteTypes';

const openView = vi.fn();

vi.mock('../NoteMenu', () => {
  return {
    NoteMenu: class {
      private options: { mode?: string };
      constructor(options: { mode?: string }) {
        this.options = options;
      }
      getTrigger(): HTMLElement {
        const trigger = document.createElement('button');
        trigger.className = 'note-menu-trigger';
        trigger.dataset.mode = this.options.mode ?? 'full';
        return trigger;
      }
    },
  };
});

vi.mock('../../../services/ViewNavigationController', () => ({
  getViewNavigationController: () => ({ openView }),
}));

vi.mock('../../../services/QuoteNoteFetcher', () => ({
  QuoteNoteFetcher: {
    getInstance: () => ({
      fetchQuotedEventWithError: vi.fn(),
    }),
  },
}));

const { UnsupportedKindRenderer } = await import('./UnsupportedKindRenderer');

const PUBKEY = 'b'.repeat(64);

function makeEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: 'a'.repeat(64),
    pubkey: PUBKEY,
    created_at: 1700000000,
    kind: 99999,
    tags: [],
    content: '',
    sig: 'c'.repeat(128),
    ...overrides,
  } as NostrEvent;
}

function makeNote(event: NostrEvent): ProcessedNote {
  return {
    id: event.id,
    type: 'unsupported',
    timestamp: event.created_at,
    author: { pubkey: event.pubkey },
    content: {
      text: '',
      html: '',
      media: [],
      links: [],
      hashtags: [],
      quotedReferences: [],
      bolt11Invoices: [],
    },
    rawEvent: event,
  };
}

function renderCard(event: NostrEvent): HTMLElement {
  return UnsupportedKindRenderer.render(makeNote(event), {});
}

describe('UnsupportedKindRenderer — NIP-5A nsite manifests', () => {
  it('renders kind 15128 root sites as an nsite card with gateway link', () => {
    const card = renderCard(
      makeEvent({
        kind: 15128,
        tags: [
          ['path', '/index.html', '1'.repeat(64)],
          ['path', '/style.css', '2'.repeat(64)],
          ['x', '3'.repeat(64), 'aggregate'],
          ['title', 'My Nostr Site'],
          ['description', 'A static website hosted on Nostr'],
          ['server', 'https://blossom.example.com'],
        ],
      })
    );

    expect(card.textContent).not.toContain('Unsupported event kind');
    expect(card.textContent).toContain('nsite · My Nostr Site');
    expect(card.textContent).toContain('A static website hosted on Nostr');
    expect(card.textContent).toContain('2 files');

    const link = card.querySelector('a.btn');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe(
      `https://${hexToNpub(PUBKEY)}.nsite.run/`
    );
  });

  it('renders kind 35128 with path tags as an nsite card (NIP-5A named site)', () => {
    const card = renderCard(
      makeEvent({
        kind: 35128,
        tags: [
          ['d', 'blog'],
          ['path', '/index.html', '1'.repeat(64)],
          ['title', 'My Blog'],
        ],
      })
    );

    expect(card.textContent).toContain('nsite · My Blog');
    expect(card.textContent).not.toContain('Unsupported event kind');
  });

  it('keeps kind 35128 without path tags on the Satellite Earth card', () => {
    const card = renderCard(
      makeEvent({
        kind: 35128,
        tags: [
          ['d', 'nap-settings'],
          ['title', 'Settings page'],
        ],
      })
    );

    expect(card.textContent).toContain('Satellite Earth page');
    expect(card.textContent).not.toContain('nsite ·');
  });
});

describe('UnsupportedKindRenderer — generic fallback chrome', () => {
  beforeEach(() => {
    openView.mockClear();
  });

  it('shows the fallback message plus the minimal menu trigger', () => {
    const card = renderCard(makeEvent({ kind: 99999 }));

    expect(card.textContent).toContain('Unsupported event kind 99999');
    const trigger = card.querySelector(
      '.note-menu-trigger'
    ) as HTMLElement | null;
    expect(trigger).not.toBeNull();
    expect(trigger?.dataset.mode).toBe('minimal');
  });

  it('navigates to SNV on plain card clicks', () => {
    const card = renderCard(makeEvent({ kind: 99999 }));

    card.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(openView).toHaveBeenCalledTimes(1);
    const [view, target] = openView.mock.calls[0];
    expect(view).toBe('single-note');
    expect(target).toBe(encodeNevent('a'.repeat(64)));
  });

  it('does not navigate when the click lands on the menu trigger', () => {
    const card = renderCard(makeEvent({ kind: 99999 }));
    const trigger = card.querySelector('.note-menu-trigger')!;

    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(openView).not.toHaveBeenCalled();
  });
});

describe('NoteMenu minimal mode', () => {
  it('offers only copy ids and raw event', async () => {
    // File-wide mock above replaces NoteMenu for the renderer tests — pull the
    // real class for this one (createMenu's minimal branch touches no services).
    const { NoteMenu: RealNoteMenu } = await vi.importActual('../NoteMenu');
    const menu = new RealNoteMenu({
      eventId: 'a'.repeat(64),
      authorPubkey: PUBKEY,
      rawEvent: makeEvent({ kind: 99999 }),
      mode: 'minimal',
    }) as unknown as { createMenu(): Promise<HTMLElement> };

    const element = await menu.createMenu();
    const actions = Array.from(
      element.querySelectorAll<HTMLElement>('.note-menu-item')
    ).map(item => item.dataset.action);

    expect(actions).toEqual([
      'copy-event-id',
      'copy-user-id',
      'view-raw-event',
    ]);
  });
});
