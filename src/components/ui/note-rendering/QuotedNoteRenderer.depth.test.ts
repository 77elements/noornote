// @vitest-environment jsdom
/**
 * Depth-cap tests for the quoted-note pipeline.
 *
 * Root cause this guards against: nested quoted reposts render recursively
 * via fetchAndRenderQuote → createQuoteBox → nested fetchAndRenderQuote —
 * with NO depth limit. A dozens-deep QR chain fetched itself endlessly
 * (TV skeleton storm, "Failed to load quoted note" at SNV, one-letter lines
 * from extreme indentation).
 *
 * Contract:
 * - Quote levels 1–3 render normally (fetch + quote box).
 * - Level 4+ renders a clickable placeholder WITHOUT any fetch, skeleton or
 *   recovery — clicking navigates to the quoted note (perspective shift;
 *   that view starts fresh at level 0 with its own 3 levels).
 * - The recovery path (retry after failed fetch) carries the depth through —
 *   a retry never resets the chain to level 1.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

const NOTE_REF =
  'nostr:nevent1qqs94phe9rjcj8pvcl2hy3lagwjaxgjvxyd72m5vvhj66tey0z4gq2gpps29c';
const NESTED_REF =
  'nostr:nevent1qqsy0z4gq2gpps29cphe9rjcj8pvcl2hy3lagwjaxgjvxyd72m5vvhj66te';

const { fetchQuotedEventWithErrorMock, routerNavigateMock } = vi.hoisted(
  () => ({
    fetchQuotedEventWithErrorMock: vi.fn(),
    routerNavigateMock: vi.fn(),
  })
);

vi.mock('../../../services/QuoteNoteFetcher', () => ({
  QuoteNoteFetcher: {
    getInstance: () => ({
      fetchQuotedEventWithError: fetchQuotedEventWithErrorMock,
    }),
  },
}));
vi.mock('../../../services/Router', () => ({
  Router: { getInstance: () => ({ navigate: routerNavigateMock }) },
}));
vi.mock('../../../services/ViewNavigationController', () => ({
  getViewNavigationController: () => ({ openView: vi.fn() }),
}));
vi.mock('../../../services/ContentProcessor', () => ({
  ContentProcessor: {
    getInstance: () => ({
      processContentWithTags: vi.fn((_content: string, tags: string[][]) => {
        const refs = tags
          .filter(t => t[0] === 'quote-ref')
          .map(t => ({ fullMatch: t[1], type: 'event' }));
        const markers = refs
          .map(
            r =>
              `<span class="quote-marker" data-quote-ref="${r.fullMatch}"></span>`
          )
          .join('');
        return {
          html: markers,
          media: [],
          bolt11Invoices: [],
          quotedReferences: refs,
        };
      }),
      processContent: vi.fn((_content: string) => ({
        html: '',
        media: [],
        bolt11Invoices: [],
        quotedReferences: [],
      })),
      getNonBlockingProfile: vi.fn(() => null),
    }),
  },
}));
vi.mock('../../../components/ui/NoteHeader', () => ({
  NoteHeader: class {
    private el = document.createElement('div');
    getElement(): HTMLElement {
      return this.el;
    }
    destroy(): void {}
  },
}));
vi.mock('../../../components/ui/note-features/CollapsibleManager', () => ({
  CollapsibleManager: {
    setup: vi.fn(),
    getInstance: () => ({ register: vi.fn(), unregister: vi.fn() }),
  },
}));
vi.mock('./ArticlePreviewRenderer', () => ({
  ArticlePreviewRenderer: {
    getInstance: () => ({
      renderFromEvent: vi.fn(),
      renderArticlePreview: vi.fn(),
    }),
  },
}));
vi.mock('../../../services/orchestration/PollOrchestrator', () => ({
  PollOrchestrator: { getInstance: () => ({ getPollData: vi.fn() }) },
}));
vi.mock('../../../lists/mutes', () => ({
  MuteOrchestrator: {
    getInstance: () => ({
      isMuted: () => ({ public: false, private: false, any: false }),
    }),
  },
  isUserMuted: () => ({ public: false, private: false, any: false }),
}));
vi.mock('../../../services/AuthService', () => ({
  AuthService: {
    getInstance: () => ({ getCurrentUser: () => ({ pubkey: 'a'.repeat(64) }) }),
  },
}));
vi.mock('./DittoFeatureRenderer', () => ({
  DittoFeatureRenderer: { render: vi.fn() },
  DITTO_GEOCACHE_KIND: 30384,
}));
vi.mock('./SatelliteSiteRenderer', () => ({
  SatelliteSiteRenderer: { render: vi.fn() },
  SATELLITE_SITE_KIND: 30442,
}));
vi.mock('./ArmadaInviteRenderer', () => ({
  ArmadaInviteRenderer: { render: vi.fn() },
}));
vi.mock('./UnsupportedKindRenderer', () => ({
  UnsupportedKindRenderer: {
    render: vi.fn(),
    renderFromCoordinate: vi.fn(() => document.createElement('div')),
  },
}));

import { QuotedNoteRenderer } from './QuotedNoteRenderer';
import { encodeNaddr } from '../../../services/NostrToolsAdapter';

function noteEvent(id: string, nestedRef?: string): NostrEvent {
  const tags: string[][] = [];
  if (nestedRef) tags.push(['quote-ref', nestedRef]);
  return {
    id,
    pubkey: 'b'.repeat(64),
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    tags,
    content: nestedRef ?? 'plain note',
    sig: 'c'.repeat(128),
  } as NostrEvent;
}

function makeRef(fullMatch: string) {
  return { fullMatch, type: 'event' as const };
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('QuotedNoteRenderer depth cap (nested QR chains)', () => {
  let renderer: QuotedNoteRenderer;

  beforeEach(() => {
    document.body.innerHTML = '';
    fetchQuotedEventWithErrorMock.mockReset();
    routerNavigateMock.mockReset();
    (
      QuotedNoteRenderer as unknown as { instance: QuotedNoteRenderer | null }
    ).instance = null;
    renderer = QuotedNoteRenderer.getInstance();
  });

  it('level 3 renders normally (fetch + quote box, no placeholder)', async () => {
    fetchQuotedEventWithErrorMock.mockResolvedValue({
      success: true,
      event: noteEvent('d'.repeat(64)),
    });
    const skeleton = document.createElement('div');
    skeleton.className = 'quote-skeleton';
    document.body.appendChild(skeleton);

    await renderer.fetchAndRenderQuote(
      makeRef(NOTE_REF),
      skeleton,
      false,
      undefined,
      false,
      3
    );
    await flush();

    expect(fetchQuotedEventWithErrorMock).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('.quote-box')).not.toBeNull();
    expect(document.body.querySelector('.quote-depth-cap')).toBeNull();
  });

  it('level 4 renders the placeholder WITHOUT fetching, skeleton or recovery', async () => {
    const skeleton = document.createElement('div');
    skeleton.className = 'quote-skeleton';
    document.body.appendChild(skeleton);

    await renderer.fetchAndRenderQuote(
      makeRef(NOTE_REF),
      skeleton,
      false,
      undefined,
      false,
      4
    );
    await flush();

    expect(fetchQuotedEventWithErrorMock).not.toHaveBeenCalled();
    expect(document.body.querySelector('.quote-skeleton')).toBeNull();
    const cap = document.body.querySelector('.quote-depth-cap')!;
    expect(cap).not.toBeNull();
    expect(cap.textContent).toContain('Quoted repost — open to view');
    // No invented IDs/hex in the placeholder
    expect(cap.textContent).not.toContain('nevent1');
  });

  it('placeholder is fully clickable and navigates to the quoted note', async () => {
    const skeleton = document.createElement('div');
    document.body.appendChild(skeleton);

    await renderer.fetchAndRenderQuote(
      makeRef(NOTE_REF),
      skeleton,
      false,
      undefined,
      false,
      4
    );
    await flush();

    const cap = document.body.querySelector('.quote-depth-cap') as HTMLElement;
    cap.click();
    expect(routerNavigateMock).toHaveBeenCalledWith(
      `/note/${NOTE_REF.replace(/^nostr:/, '')}`
    );
  });

  it('nested quotes inside a rendered level increment the depth (level 3 nests to capped 4)', async () => {
    // Level-3 event itself quotes another note → that nested ref is level 4 → capped.
    fetchQuotedEventWithErrorMock.mockImplementation(async (_ref: string) => ({
      success: true,
      event: noteEvent('d'.repeat(64), NESTED_REF),
    }));
    const skeleton = document.createElement('div');
    document.body.appendChild(skeleton);

    await renderer.fetchAndRenderQuote(
      makeRef(NOTE_REF),
      skeleton,
      false,
      undefined,
      false,
      3
    );
    await flush();
    await flush();

    // Outer quote box rendered from the level-3 fetch; the nested level-4
    // ref became the cap placeholder — no further fetch for NESTED_REF.
    expect(document.body.querySelector('.quote-box')).not.toBeNull();
    expect(document.body.querySelector('.quote-depth-cap')).not.toBeNull();
    const nestedFetches = fetchQuotedEventWithErrorMock.mock.calls.filter(
      call => call[0] === NESTED_REF
    );
    expect(nestedFetches).toHaveLength(0);
  });

  it('recovery retry carries the depth through (failure at level 3 retries at level 3)', async () => {
    vi.useFakeTimers();
    // Real failure mode: the fetcher RESOLVES with a QuoteFetchError result
    // (thrown errors go to the outer catch, not the recovery path).
    fetchQuotedEventWithErrorMock
      .mockResolvedValueOnce({
        success: false,
        error: { type: 'network', message: 'relay timeout', canRetry: true },
      })
      .mockResolvedValue({
        success: true,
        event: noteEvent('d'.repeat(64)),
      });
    const skeleton = document.createElement('div');
    document.body.appendChild(skeleton);

    await renderer.fetchAndRenderQuote(
      makeRef(NOTE_REF),
      skeleton,
      false,
      undefined,
      false,
      3
    );

    // Recovery retry fires 8 s later (outboundOnly) — still at level 3
    await vi.advanceTimersByTimeAsync(8000);
    await vi.advanceTimersByTimeAsync(0);

    // Recovery ran: outboundOnly retry (1) + the full cache-first re-render
    // fetch (2) after the initial failure — and the depth was carried, so the
    // level-3 quote rendered as a real quote box, NOT the depth-cap placeholder.
    expect(fetchQuotedEventWithErrorMock).toHaveBeenCalledTimes(3);
    expect(document.body.querySelector('.quote-box')).not.toBeNull();
    expect(document.body.querySelector('.quote-depth-cap')).toBeNull();
    vi.useRealTimers();
  });
});

describe('renderAddressableReference — regular note kinds wrapped in naddr', () => {
  let renderer: QuotedNoteRenderer;

  beforeEach(() => {
    document.body.innerHTML = '';
    fetchQuotedEventWithErrorMock.mockReset();
    routerNavigateMock.mockReset();
    (
      QuotedNoteRenderer as unknown as { instance: QuotedNoteRenderer | null }
    ).instance = null;
    renderer = QuotedNoteRenderer.getInstance();
  });

  it('naddr with kind 1 (fanfares-style) fetches and renders a regular quote box', async () => {
    // fanfares.io encodes kind-1 notes as naddr URLs; the old router saw
    // kind 1 outside the 30000 block and showed "Unsupported event kind 1".
    const container = document.createElement('div');
    document.body.appendChild(container);

    fetchQuotedEventWithErrorMock.mockResolvedValue({
      success: true,
      event: noteEvent('d'.repeat(64)),
    });

    renderer.renderAddressableReference(
      'nostr:naddr1qvzqqqqqqypzpamkhnqjyud70878rdj4709lavag595lx0hpxd0ucrpzs2vsrkj2qyvhwumn8ghj7enpdenxzun9wvhxummnw3erztnrdaksqfrrv33n2cn9v5mj6vtrxvmz6dph8qcz6c3cx43z6ve5venrvvek8qmxvdejqz2fpp',
      container
    );
    await flush();
    await flush();

    expect(fetchQuotedEventWithErrorMock).toHaveBeenCalledTimes(1);
    expect(fetchQuotedEventWithErrorMock.mock.calls[0]![0]).toContain('naddr1');
    expect(container.querySelector('.quote-box')).not.toBeNull();
    expect(container.querySelector('.quote-error')).toBeNull();
    expect(container.textContent).not.toContain('Unsupported event kind');
  });

  it('addressable kinds (30023) still route to their dedicated card, no id fetch', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    const articleNaddr = encodeNaddr({
      kind: 30023,
      pubkey: 'f'.repeat(64),
      identifier: 'my-article',
      relays: [],
    });
    renderer.renderAddressableReference(`nostr:${articleNaddr}`, container);
    await flush();

    expect(fetchQuotedEventWithErrorMock).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Unsupported event kind 30023');
  });
});
