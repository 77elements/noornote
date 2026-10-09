// @vitest-environment jsdom
/**
 * NIP-5A nsite routing + fallback card tests.
 *
 * 1. Nsite manifests (kind 15128 root / kind 35128 named) route through
 *    NoteProcessor to the nsite pipeline and render as a full note card
 *    (header, ISL, file list, gateway link) — never into the generic
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

const PUBKEY = 'b'.repeat(64);
// Deliberately unknown kind for fallback tests — not a real Nostr kind.
const UNKNOWN_KIND = 99999;
// NoteProcessor memoizes per event id — every fixture needs a unique id or the
// cache serves a previous test's note.
let idCounter = 0;
const nextId = () => (idCounter++).toString(16).padStart(64, '0');
const EVENT_ID = nextId();

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

vi.mock('../NoteHeader', () => ({
  NoteHeader: class {
    private el = document.createElement('div');
    getElement(): HTMLElement {
      return this.el;
    }
    destroy(): void {}
  },
}));

vi.mock('../../../services/ViewNavigationController', () => ({
  getViewNavigationController: () => ({ openView }),
}));

vi.mock('../../../services/ContentProcessor', async () => {
  const { contentProcessorMock } = await import('../noteTestMocks');
  return { ContentProcessor: contentProcessorMock };
});

vi.mock('../../../services/UserProfileService', async () => {
  const { userProfileServiceMock } = await import('../noteTestMocks');
  return { UserProfileService: userProfileServiceMock };
});

vi.mock('../../../services/QuoteNoteFetcher', () => ({
  QuoteNoteFetcher: {
    getInstance: () => ({
      fetchQuotedEventWithError: vi.fn(),
    }),
  },
}));

vi.mock('../../../lists/mutes', () => ({
  MuteOrchestrator: {
    getInstance: () => ({
      isMuted: () => ({ public: false, private: false, any: false }),
    }),
  },
  isUserMuted: () => ({ public: false, private: false, any: false }),
  isEventHidden: () => false,
}));

vi.mock('../../../services/AuthService', () => ({
  AuthService: {
    getInstance: () => ({ getCurrentUser: () => null }),
  },
}));

vi.mock('../../../services/ClipboardActionsService', () => ({
  ClipboardActionsService: {
    getInstance: () => ({
      copyText: vi.fn(async () => true),
      addVisualFeedback: vi.fn(),
    }),
  },
}));

import { NoteProcessor } from '../note-processing/NoteProcessor';
import { NoteRendererFactory } from './NoteRendererFactory';
import { UnsupportedKindRenderer } from './UnsupportedKindRenderer';
import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';

function makeEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: overrides.id ?? nextId(),
    pubkey: PUBKEY,
    created_at: 1700000000,
    kind: UNKNOWN_KIND,
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

const OPTS: NoteUIOptions = {
  collapsible: false,
  islFetchStats: false,
  isLoggedIn: false,
  headerSize: 'medium',
  depth: 0,
};

describe('NoteProcessor NIP-5A nsite routing', () => {
  it('routes kind 15128 root manifests to the nsite pipeline', () => {
    const note = NoteProcessor.process(
      makeEvent({
        kind: 15128,
        tags: [
          ['path', '/index.html', '1'.repeat(64)],
          ['title', 'My Nostr Site'],
        ],
      })
    );
    expect(note.type).toBe('nsite');
    expect(note.content.text).toBe('My Nostr Site');
  });

  it('routes kind 35128 with path tags to the nsite pipeline', () => {
    const note = NoteProcessor.process(
      makeEvent({
        kind: 35128,
        tags: [
          ['d', 'blog'],
          ['path', '/index.html', '1'.repeat(64)],
          ['title', 'My Blog'],
        ],
      })
    );
    expect(note.type).toBe('nsite');
  });

  it('keeps kind 35128 without path tags on the unsupported path (Satellite Earth)', () => {
    const note = NoteProcessor.process(
      makeEvent({
        kind: 35128,
        tags: [
          ['d', 'nap-settings'],
          ['title', 'Settings page'],
        ],
      })
    );
    expect(note.type).toBe('unsupported');
  });
});

describe('NsiteRenderer card', () => {
  it('renders a full note card with file list and gateway link', () => {
    const note = NoteProcessor.process(
      makeEvent({
        kind: 15128,
        tags: [
          ['path', '/index.html', '1'.repeat(64)],
          ['path', '/style.css', '2'.repeat(64)],
          ['x', '3'.repeat(64), 'aggregate'],
          ['title', 'My Nostr Site'],
          ['description', 'A static website hosted on Nostr'],
        ],
      })
    );
    const card = NoteRendererFactory.render(note, OPTS);

    expect(card.className).toContain('note-card--nsite');
    expect(card.textContent).toContain('nsite · My Nostr Site');
    expect(card.textContent).toContain('A static website hosted on Nostr');
    expect(card.textContent).toContain('2 files');
    // No file listing — the count in the meta line is all the detail we show
    expect(card.textContent).not.toContain('/index.html');

    const link = card.querySelector('a.btn');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe(
      `https://${hexToNpub(PUBKEY)}.nsite.run/`
    );

    // Full note shell: ISL mounts (hex id for the replaceable root manifest)
    expect(card.querySelector('.isl')).not.toBeNull();

    // Aggregate hash offered as copyable
    const copyBtn = card.querySelector(
      '.nsite-card__hash-copy'
    ) as HTMLElement | null;
    expect(copyBtn).not.toBeNull();
    expect(copyBtn?.dataset.hash).toBe('3'.repeat(64));
  });

  it('never shows the unsupported fallback for nsites', () => {
    const note = NoteProcessor.process(
      makeEvent({
        kind: 15128,
        tags: [['path', '/index.html', '1'.repeat(64)]],
      })
    );
    const card = NoteRendererFactory.render(note, OPTS);
    expect(card.textContent).not.toContain('Unsupported event kind');
  });
});

describe('UnsupportedKindRenderer — Satellite card for shared kind 35128', () => {
  it('renders kind 35128 without path tags as a Satellite Earth notice', () => {
    const note = NoteProcessor.process(
      makeEvent({
        kind: 35128,
        tags: [
          ['d', 'nap-settings'],
          ['title', 'Settings page'],
        ],
      })
    );
    const card = NoteRendererFactory.render(note, OPTS);

    expect(card.textContent).toContain('Satellite Earth page');
    expect(card.textContent).not.toContain('nsite ·');
  });
});

describe('UnsupportedKindRenderer — generic fallback chrome', () => {
  beforeEach(() => {
    openView.mockClear();
  });

  it('shows the fallback message plus the minimal menu trigger', () => {
    const card = UnsupportedKindRenderer.render(makeNote(makeEvent()), OPTS);

    expect(card.textContent).toContain('Unsupported event kind 99999');
    const trigger = card.querySelector(
      '.note-menu-trigger'
    ) as HTMLElement | null;
    expect(trigger).not.toBeNull();
    expect(trigger?.dataset.mode).toBe('minimal');
  });

  it('navigates to SNV on plain card clicks', () => {
    const event = makeEvent();
    const card = UnsupportedKindRenderer.render(makeNote(event), OPTS);

    card.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(openView).toHaveBeenCalledTimes(1);
    const [view, target] = openView.mock.calls[0];
    expect(view).toBe('single-note');
    expect(target).toBe(encodeNevent(event.id));
  });

  it('does not navigate when the click lands on the menu trigger', () => {
    const card = UnsupportedKindRenderer.render(makeNote(makeEvent()), OPTS);
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
      eventId: EVENT_ID,
      authorPubkey: PUBKEY,
      rawEvent: makeEvent(),
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
