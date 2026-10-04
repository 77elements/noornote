/// <reference types="vite/client" />

// SVG imports return URL string
declare module '*.svg' {
  const src: string;
  export default src;
}

// PNG imports return URL string
declare module '*.png' {
  const src: string;
  export default src;
}

// JPG/JPEG imports return URL string
declare module '*.jpg' {
  const src: string;
  export default src;
}
declare module '*.jpeg' {
  const src: string;
  export default src;
}

// WebLN provider (injected by Keychat browser, Alby extension, etc.)
interface WebLNProvider {
  enable(): Promise<{ enabled: boolean }>;
  sendPayment(paymentRequest: string): Promise<string | { preimage: string }>;
}

interface Window {
  webln?: WebLNProvider;
}

// Vite define() constants (injected at build time — see vite.config.ts)
declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;
declare const __BUILD_ID__: string;
/**
 * gifs.nostr.build API key — ONLY defined during APK builds (the /apk skill
 * exports GNB_API_KEY from ~/.noornote/nostrbuild-gif-key). Must stay empty in
 * web bundles: the key must never ship in the public web bundle. Empty string
 * on web/Electron dev — Electron resolves the key in its main process instead.
 */
declare const __GNB_API_KEY__: string;
