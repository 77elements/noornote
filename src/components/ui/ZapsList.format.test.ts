// @vitest-environment jsdom
/**
 * ZapsList rendering tests.
 *
 * Slice 1 (production bugfix): zapper retries — the same payment published
 * twice under different event ids — must render as ONE row (dedupe by
 * bolt11, one payment = one invoice = one row).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const ME = 'a'.repeat(64);

vi.mock('../../services/UserProfileService', () => ({
  UserProfileService: {
    getInstance: () => ({
      getUserProfile: vi.fn(async () => ({
        pubkey: 'd'.repeat(64),
        name: 'alp',
        display_name: 'Alp',
        picture: 'https://img.test/alp.png',
      })),
    }),
  },
}));
vi.mock('../../services/AuthService', () => ({
  AuthService: {
    getInstance: () => ({ getCurrentUser: () => ({ pubkey: ME }) }),
  },
}));
vi.mock('../../core/ModuleLoader', () => ({
  ModuleLoader: { getInstance: () => ({ getApi: () => null }) },
}));
vi.mock('./UserHoverCard', () => ({
  UserHoverCard: { getInstance: () => ({ show: vi.fn(), hide: vi.fn() }) },
}));
vi.mock('./Tooltip', () => ({ Tooltip: { attach: vi.fn() } }));
vi.mock('../../services/ViewNavigationController', () => ({
  getViewNavigationController: () => ({ openView: vi.fn() }),
}));

import { ZapsList } from './ZapsList';
import type { ZapPendingState } from '../../services/ZapService';

function pending(
  invoice: string,
  amount: number,
  comment?: string
): ZapPendingState {
  return {
    invoice,
    noteId: 'c'.repeat(64),
    amount,
    state: 'succeeded',
    startedAt: 0,
    ...(comment && { comment }),
  };
}

function receipt(id: string, bolt11: string, comment = '') {
  // Real receipts carry the zap request (kind 9734) — and with it the
  // comment — inside the `description` tag as embedded JSON.
  const tags: string[][] = [
    ['bolt11', bolt11],
    ['p', 'e'.repeat(64)],
  ];
  if (comment) {
    tags.push([
      'description',
      JSON.stringify({ pubkey: 'd'.repeat(64), content: comment }),
    ]);
  }
  return {
    id,
    kind: 9735,
    pubkey: 'd'.repeat(64),
    tags,
    content: '',
  } as never;
}

function badgeTexts(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll('.zaps-list__amount')).map(
    el => el.textContent ?? ''
  );
}

describe('ZapsList receipt rendering', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('zapper retry (two receipts, same bolt11, different ids) renders once', async () => {
    const bolt11 = 'lnbc50m1zaptestinvoice';
    const list = new ZapsList([receipt('r1', bolt11), receipt('r2', bolt11)]);
    document.body.appendChild(list.getElement());
    await vi.waitFor(() => {
      expect(
        list.getElement().querySelectorAll('.zaps-list__badge').length
      ).toBe(1);
    });
    expect(badgeTexts(list.getElement())).toEqual(['5,000,000']);
  });

  it('different invoices render as separate rows', async () => {
    const list = new ZapsList([
      receipt('r1', 'lnbc50m1a'),
      receipt('r2', 'lnbc21m1b'),
    ]);
    document.body.appendChild(list.getElement());
    await vi.waitFor(() => {
      expect(
        list.getElement().querySelectorAll('.zaps-list__badge').length
      ).toBe(2);
    });
  });

  it('comment zaps render "⚡ amount comment", others "Zapped by username"', async () => {
    const list = new ZapsList([
      receipt('r1', 'lnbc50m1a', 'Great post!'),
      receipt('r2', 'lnbc21m1b'),
    ]);
    document.body.appendChild(list.getElement());
    await vi.waitFor(() => {
      expect(
        list.getElement().querySelectorAll('.zaps-list__badge').length
      ).toBe(2);
    });

    const texts = Array.from(
      list.getElement().querySelectorAll('.zaps-list__text')
    ).map(el => el.textContent ?? '');
    expect(texts).toContain('Great post!');
    expect(texts).toContain('Zapped by Alp');
  });

  describe('optimistic pending rows (exact same markup as receipt rows)', () => {
    it('pending without comment renders "⚡ amount Zapped by <own name>"', async () => {
      const list = new ZapsList([], [pending('lnbc50m1p', 50)]);
      document.body.appendChild(list.getElement());
      await vi.waitFor(() => {
        expect(
          list.getElement().querySelectorAll('.zaps-list__badge').length
        ).toBe(1);
      });

      const badge = list.getElement().querySelector('.zaps-list__badge')!;
      // Same markup classes as receipt rows — no invented pending styling
      expect(badge.classList.contains('zaps-list__badge--pending')).toBe(false);
      expect(badge.classList.contains('pulsate')).toBe(false);
      expect(badgeTexts(list.getElement())).toEqual(['50']);
      expect(badge.querySelector('.zaps-list__text')!.textContent).toBe(
        'Zapped by Alp'
      );
      // No receipt event → not replyable
      expect(badge.classList.contains('zaps-list__badge--replyable')).toBe(
        false
      );
    });

    it('pending with comment renders "⚡ amount comment"', async () => {
      const list = new ZapsList([], [pending('lnbc50m1p', 50, 'Great post!')]);
      document.body.appendChild(list.getElement());
      await vi.waitFor(() => {
        expect(
          list.getElement().querySelectorAll('.zaps-list__badge').length
        ).toBe(1);
      });

      const badge = list.getElement().querySelector('.zaps-list__badge')!;
      expect(badge.querySelector('.zaps-list__text')!.textContent).toBe(
        'Great post!'
      );
      expect(badgeTexts(list.getElement())).toEqual(['50']);
    });

    it('receipt wins over pending with the same bolt11 — no duplicate row', async () => {
      const bolt11 = 'lnbc50m1same';
      const list = new ZapsList([receipt('r1', bolt11)], [pending(bolt11, 50)]);
      document.body.appendChild(list.getElement());
      await vi.waitFor(() => {
        expect(
          list.getElement().querySelectorAll('.zaps-list__badge').length
        ).toBe(1);
      });
      // The rendered row is the RECEIPT row (replyable)
      const badge = list.getElement().querySelector('.zaps-list__badge')!;
      expect(badge.classList.contains('zaps-list__badge--replyable')).toBe(
        true
      );
    });

    it('pending and unrelated receipts coexist, sorted by amount', async () => {
      const list = new ZapsList(
        [receipt('r1', 'lnbc50m1a')],
        [pending('lnbc210m1p', 210)]
      );
      document.body.appendChild(list.getElement());
      await vi.waitFor(() => {
        expect(
          list.getElement().querySelectorAll('.zaps-list__badge').length
        ).toBe(2);
      });
      // sorted by amount descending: 5,000,000 (receipt) before 210 (pending)
      expect(badgeTexts(list.getElement())).toEqual(['5,000,000', '210']);
    });
  });
});
