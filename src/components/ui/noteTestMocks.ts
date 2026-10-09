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

import { vi } from 'vitest';

export const collapsibleManagerMock = {
  setup: vi.fn(),
  getInstance: () => ({ register: vi.fn(), unregister: vi.fn() }),
};

export const articlePreviewRendererMock = {
  getInstance: () => ({
    renderFromEvent: vi.fn(),
    renderArticlePreview: vi.fn(),
  }),
};

export const pollOrchestratorMock = {
  getInstance: () => ({ getPollData: vi.fn() }),
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

export const dittoMock = { render: vi.fn(), DITTO_GEOCACHE_KIND: 30384 };

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
