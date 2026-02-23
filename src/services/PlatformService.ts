/**
 * PlatformService - Central Platform Detection
 *
 * Provides feature flags based on runtime environment (Browser vs Tauri).
 * Use this instead of checking __TAURI_INTERNALS__ directly.
 *
 * Usage:
 * const platform = PlatformService.getInstance();
 * if (platform.isTauri) { ... }
 * if (platform.supportsNip07) { ... }
 */

export type PlatformType = 'tauri' | 'browser';

export class PlatformService {
  private static instance: PlatformService;

  /** Current platform type */
  readonly platformType: PlatformType;

  /** True if running in Tauri */
  readonly isTauri: boolean;

  /** True if running in browser (including Rust-server mode) */
  readonly isBrowser: boolean;

  /** True if NoorSigner is available (Tauri only) */
  readonly supportsNoorSigner: boolean;

  /** True if NIP-07 extensions can be used (Browser + Tauri with extension) */
  readonly supportsNip07: boolean;

  /** True if Keychain storage is available (Tauri only) */
  readonly supportsKeychain: boolean;

  /** True if native file dialogs are available (Tauri only) */
  readonly supportsNativeFileDialog: boolean;

  /** True if running on macOS */
  readonly isMac: boolean;

  /** True if running on Linux */
  readonly isLinux: boolean;

  /** True if running on Android (Tauri mobile) */
  readonly isAndroid: boolean;

  /** True if Amber (NIP-55) signer can be used (Tauri Android only) */
  readonly supportsAmber: boolean;

  private constructor() {
    // Detect Tauri environment
    this.isTauri = typeof window !== 'undefined' &&
      (window as any).__TAURI_INTERNALS__ !== undefined;

    this.isBrowser = !this.isTauri;
    this.platformType = this.isTauri ? 'tauri' : 'browser';

    // OS detection (must come before feature flags)
    const navPlatform = navigator.platform?.toLowerCase() || '';
    const userAgent = navigator.userAgent?.toLowerCase() || '';
    this.isMac = navPlatform.includes('mac') || userAgent.includes('mac');
    this.isLinux = navPlatform.includes('linux') || userAgent.includes('linux');

    // Android detection: build-time flag from Tauri CLI (most reliable),
    // fallback to userAgent check for runtime detection
    const tauriPlatform = (import.meta as any).env?.TAURI_ENV_PLATFORM || '';
    this.isAndroid = tauriPlatform === 'android' || userAgent.includes('android');

    // Feature flags (desktop only, not mobile)
    const isDesktop = this.isTauri && !this.isAndroid;
    this.supportsNoorSigner = isDesktop;
    this.supportsKeychain = isDesktop;
    this.supportsNativeFileDialog = isDesktop;

    // NIP-07 available in browser, and potentially in Tauri if extension installed
    this.supportsNip07 = this.isBrowser || this.hasNip07Extension();

    // Amber (NIP-55) only available in Tauri on Android
    this.supportsAmber = this.isTauri && this.isAndroid;

    // Set platform CSS class on <html> for platform-specific styling
    if (this.isAndroid) {
      document.documentElement.classList.add('platform--mobile');
    }
  }

  public static getInstance(): PlatformService {
    if (!PlatformService.instance) {
      PlatformService.instance = new PlatformService();
    }
    return PlatformService.instance;
  }

  /**
   * Check if NIP-07 extension (window.nostr) is available
   */
  private hasNip07Extension(): boolean {
    return typeof window !== 'undefined' && (window as any).nostr !== undefined;
  }

  /**
   * Re-check NIP-07 availability (extensions may load after page load)
   */
  public checkNip07Available(): boolean {
    return typeof window !== 'undefined' && (window as any).nostr !== undefined;
  }
}
