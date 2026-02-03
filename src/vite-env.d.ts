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
