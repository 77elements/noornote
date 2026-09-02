// @vitest-environment jsdom
/**
 * Gated premium note rendering (fanfares): kind 1 + ["encrypted","aes-256-gcm"]
 * + ["price",N,"SATS"] tags. The teaser ends in a self-referential fanfares.io
 * CTA — rendering it as a quote reference recurses forever, so gated events
 * MUST render as a card with no nested quote fetches, in every surface.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

const AUTHOR =
  'f776bcc12271be79fc71b655f3cbfeb3a8a169f33ee1335fcc0c22829901da4a';
const UUID = 'cdc5bee7-1c36-4780-b85b-34ff63686f72';
const NADDR =
  'naddr1qvzqqqqqqypzpamkhnqjyud70878rdj4709lavag595lx0hpxd0ucrpzs2vsrkj2qyvhwumn8ghj7enpdenxzun9wvhxummnw3erztnrdaksqfrrv33n2cn9v5mj6vtrxvmz6dph8qcz6c3cx43z6ve5venrvvek8qmxvdejqz2fpp';

const { fetchQuotedEventWithErrorMock } = vi.hoisted(() => ({
  fetchQuotedEventWithErrorMock: vi.fn(),
}));

vi.mock('../../../services/QuoteNoteFetcher', () => ({
  QuoteNoteFetcher: {
    getInstance: () => ({
      fetchQuotedEventWithError: fetchQuotedEventWithErrorMock,
    }),
  },
}));
vi.mock('../../../services/Router', () => ({
  Router: { getInstance: () => ({ navigate: vi.fn() }) },
}));
vi.mock('../../../services/ViewNavigationController', () => ({
  getViewNavigationController: () => ({ openView: vi.fn() }),
}));
vi.mock('../../../services/ContentProcessor', () => ({
  ContentProcessor: {
    getInstance: () => ({
      processContentWithTags: vi.fn((text: string) => ({
        html: text,
        text,
        media: [],
        bolt11Invoices: [],
        quotedReferences: [],
      })),
      processContent: vi.fn((text: string) => {
        // Emulate the real pipeline: media URLs → __MEDIA_N__ markers
        const urls =
          text.match(/https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)/gi) ?? [];
        let html = text;
        urls.forEach((u, i) => {
          html = html.replace(u, `__MEDIA_${i}__`);
        });
        return {
          html,
          text,
          media: urls.map(u => ({ type: 'image', url: u })),
          bolt11Invoices: [],
          quotedReferences: [],
        };
      }),
      getNonBlockingProfile: vi.fn(() => null),
    }),
  },
}));
vi.mock('../NoteHeader', () => ({
  NoteHeader: class {
    private el = document.createElement('div');
    getElement(): HTMLElement {
      return this.el;
    }
    destroy(): void {}
  },
}));
vi.mock('../note-features/CollapsibleManager', () => ({
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
import { GatedNoteRenderer } from './GatedNoteRenderer';
import { TextNoteProcessor } from '../note-processing/TextNoteProcessor';

const premiumEvent = (): NostrEvent =>
  ({
    id: '0eaa004a6c08'.padEnd(64, '0'),
    pubkey: AUTHOR,
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    tags: [
      ['d', UUID],
      ['encrypted', 'aes-256-gcm', 'blob'],
      ['price', '19186', 'SATS'],
      ['zap', AUTHOR, 'wss://fanfares.nostr1.com', '19186'],
    ],
    content: `Teaser story text\nhttps://api.fanfares.live/cdn/teaser.jpg\n⚡Zap 19186 sats to unlock this note on\nhttps://fanfares.io/naddr/${NADDR}`,
    sig: 'c'.repeat(128),
  }) as NostrEvent;

describe('Gated premium note rendering (fanfares)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    fetchQuotedEventWithErrorMock.mockReset();
    (
      QuotedNoteRenderer as unknown as { instance: QuotedNoteRenderer | null }
    ).instance = null;
  });

  it('quote pipeline: gated event renders the card, NOT a quote box, no nested fetch', async () => {
    fetchQuotedEventWithErrorMock.mockResolvedValue({
      success: true,
      event: premiumEvent(),
    });
    const renderer = QuotedNoteRenderer.getInstance();
    const skeleton = document.createElement('div');
    document.body.appendChild(skeleton);

    await renderer.fetchAndRenderQuote(
      { fullMatch: 'nostr:nevent1abc', type: 'event' },
      skeleton,
      false,
      undefined,
      false,
      1
    );
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(document.body.querySelector('.gated-note-card')).not.toBeNull();
    expect(document.body.querySelector('.quote-box')).toBeNull();
    expect(document.body.querySelector('.quote-skeleton')).toBeNull();
    // The unlock CTA shows the price and links to fanfares.io
    const cta = document.body.querySelector(
      '[data-gated-cta]'
    ) as HTMLAnchorElement;
    expect(cta).not.toBeNull();
    expect(cta.href).toContain('fanfares.io/naddr/');
    // exactly ONE fetch — the self-referential CTA never refetches
    expect(fetchQuotedEventWithErrorMock).toHaveBeenCalledTimes(1);
  });

  it('the card teaser is CTA-stripped (no self-referential fanfares URL)', async () => {
    fetchQuotedEventWithErrorMock.mockResolvedValue({
      success: true,
      event: premiumEvent(),
    });
    const renderer = QuotedNoteRenderer.getInstance();
    const skeleton = document.createElement('div');
    document.body.appendChild(skeleton);

    await renderer.fetchAndRenderQuote(
      { fullMatch: 'nostr:nevent1abc', type: 'event' },
      skeleton,
      false,
      undefined,
      false,
      1
    );
    await new Promise(resolve => setTimeout(resolve, 0));

    const card = document.body.querySelector('.gated-note-card')!;
    expect(card.textContent).toContain('Teaser story text');
    expect(card.textContent).not.toContain('⚡Zap 19186');
    expect(card.textContent).not.toContain('fanfares.io/naddr');
  });

  it('processor routes gated kind-1 events to type "premium" with a CTA-stripped teaser', () => {
    const note = TextNoteProcessor.process(premiumEvent());
    expect(note.type).toBe('premium');
    expect(note.content.quotedReferences).toHaveLength(0);
    expect(note.content.html).not.toContain('⚡Zap 19186');
    expect(note.content.html).toContain('Teaser story text');
  });

  it('quote card click opens fanfares.io (external unlock)', async () => {
    const openMock = vi.fn();
    const originalOpen = window.open;
    window.open = openMock as never;
    try {
      fetchQuotedEventWithErrorMock.mockResolvedValue({
        success: true,
        event: premiumEvent(),
      });
      const renderer = QuotedNoteRenderer.getInstance();
      const skeleton = document.createElement('div');
      document.body.appendChild(skeleton);

      await renderer.fetchAndRenderQuote(
        { fullMatch: 'nostr:nevent1abc', type: 'event' },
        skeleton,
        false,
        undefined,
        false,
        1
      );
      await new Promise(resolve => setTimeout(resolve, 0));

      const card = document.body.querySelector(
        '.gated-note-card'
      ) as HTMLElement;
      card.click();
      expect(openMock).toHaveBeenCalledTimes(1);
      expect(String(openMock.mock.calls[0]![0])).toContain(
        'fanfares.io/naddr/'
      );
    } finally {
      window.open = originalOpen;
    }
  });

  it('GatedNoteRenderer.render builds the full note shell with CTA (root notes)', () => {
    const note = TextNoteProcessor.process(premiumEvent());
    const element = GatedNoteRenderer.render(note, {
      depth: 0,
      collapsible: false,
    });

    expect(element.className).toContain('note-card--gated');
    expect(element.textContent).toContain('Teaser story text');
    expect(element.querySelector('[data-gated-cta]')).not.toBeNull();
    expect(
      element.querySelector('.gated-note__teaser')!.textContent
    ).not.toContain('⚡Zap 19186');
  });
});
