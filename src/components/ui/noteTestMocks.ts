/**
 * Shared vi.mock payloads for note-rendering/note-processing tests.
 *
 * Test-only: imported exclusively from *.test.ts files, never by app code.
 * vi.mock factories are hoisted, so load these via dynamic import inside the
 * factory:
 *
 *   vi.mock('../../../services/ContentProcessor', async () => {
 *     const { contentProcessorMock } = await import('../noteTestMocks');
 *     return { ContentProcessor: contentProcessorMock };
 *   });
 */

import { vi, type Mock } from 'vitest';

// Explicit `Mock` annotations: vitest 5's inferred vi.fn() types reference an
// internal chunk file, which breaks declaration portability (TS2742/TS2883)
// under both TS 5.9 and TS 7.
export const collapsibleManagerMock = {
  setup: vi.fn() as Mock,
  getInstance: () => ({
    register: vi.fn() as Mock,
    unregister: vi.fn() as Mock,
  }),
};

export const articlePreviewRendererMock = {
  getInstance: () => ({
    renderFromEvent: vi.fn() as Mock,
    renderArticlePreview: vi.fn() as Mock,
  }),
};

export const pollOrchestratorMock = {
  getInstance: () => ({ getPollData: vi.fn() as Mock }),
};

export const mutesMock = {
  MuteOrchestrator: {
    getInstance: () => ({
      isMuted: () => ({ public: false, private: false, any: false }),
    }),
  },
  isUserMuted: () => ({ public: false, private: false, any: false }),
};

export const authServiceMock64 = {
  getInstance: () => ({ getCurrentUser: () => ({ pubkey: 'a'.repeat(64) }) }),
};

export const dittoMock = {
  render: vi.fn() as Mock,
  DITTO_GEOCACHE_KIND: 30384,
};

export const contentProcessorMock = {
  getInstance: () => ({
    processContentWithTags: (text: string) => ({
      text,
      html: text,
      media: [],
      links: [],
      hashtags: [],
      quotedReferences: [],
      bolt11Invoices: [],
    }),
    getNonBlockingProfile: () => null,
  }),
};

export const userProfileServiceMock = {
  getInstance: () => ({ getUsername: () => null }),
};
