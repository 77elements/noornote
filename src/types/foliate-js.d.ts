/**
 * foliate-js ships as untyped JavaScript (no .d.ts, no @types package).
 * The reader engine is dynamically imported in EpubReaderService and cast to
 * a minimal local interface there — see FoliateView in EpubReaderService.ts.
 */
declare module 'foliate-js/view.js';
