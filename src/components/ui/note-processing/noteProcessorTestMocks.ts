/**
 * Shared vi.mock factories for NoteProcessor-adjacent test suites.
 *
 * The real ContentProcessor / UserProfileService / AuthService pull in the
 * lists/AutoSync chain (PlatformService, SystemLogger singletons) which
 * cannot load in the node/jsdom test environment — stub them at the
 * boundary. Used via async factories so the hoisted vi.mock call can import
 * this helper:
 *
 *   vi.mock('../../../services/ContentProcessor', async () => {
 *     const { contentProcessorMock } = await import('./noteProcessorTestMocks');
 *     return contentProcessorMock;
 *   });
 */

export const contentProcessorMock = {
  ContentProcessor: {
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
  },
};
