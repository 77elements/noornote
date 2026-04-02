/**
 * PlatformService - Central Platform Detection
 *
 * Provides feature flags based on runtime environment.
 * Use this instead of checking platform internals directly.
 *
 * Usage:
 * const platform = PlatformService.getInstance();
 * if (platform.isElectron) { ... }  // Desktop (Electron)
 * if (platform.isCapacitor) { ... } // Android (Capacitor)
 * if (platform.isBrowser) { ... }   // Web (noornote.app)
 */

export type PlatformType = 'electron' | 'capacitor' | 'browser';

export class PlatformService {
  private static instance: PlatformService;

  /** Current platform type */
  readonly platformType: PlatformType;

  /** True if running in Electron (Desktop) */
  readonly isElectron: boolean;

  /** True if running in Capacitor (Android) */
  readonly isCapacitor: boolean;

  /** True if running in browser (not Electron, not Capacitor) */
  readonly isBrowser: boolean;

  /** True if running as a desktop app (Electron) */
  readonly isDesktop: boolean;

  /** True if NoorSigner is available (Desktop only) */
  readonly supportsNoorSigner: boolean;

  /** True if NIP-07 extensions can be used (Browser + Desktop with extension) */
  readonly supportsNip07: boolean;

  /** True if Keychain/EncryptedFile storage is available (Desktop only) */
  readonly supportsKeychain: boolean;

  /** True if native file dialogs are available (Desktop only) */
  readonly supportsNativeFileDialog: boolean;

  /** True if running on macOS */
  readonly isMac: boolean;

  /** True if running on Linux */
  readonly isLinux: boolean;

  /** True if running on Android */
  readonly isAndroid: boolean;

  /** True if Amber (NIP-55) signer can be used (Android native only) */
  readonly supportsAmber: boolean;

  private constructor() {
    // Detect runtime environment
    this.isElectron = typeof window !== 'undefined' &&
      (window as any).electronAPI !== undefined;

    this.isCapacitor = typeof window !== 'undefined' &&
      (window as any).Capacitor !== undefined;

    this.isBrowser = !this.isElectron && !this.isCapacitor;

    // Platform type (priority: Electron > Capacitor > Browser)
    if (this.isElectron) this.platformType = 'electron';
    else if (this.isCapacitor) this.platformType = 'capacitor';
    else this.platformType = 'browser';

    // OS detection
    const navPlatform = navigator.platform?.toLowerCase() || '';
    const userAgent = navigator.userAgent?.toLowerCase() || '';
    this.isMac = navPlatform.includes('mac') || userAgent.includes('mac');
    this.isLinux = navPlatform.includes('linux') || userAgent.includes('linux');

    // Android detection (Capacitor or userAgent)
    this.isAndroid = this.isCapacitor ||
      userAgent.includes('android');

    // Desktop = Electron
    this.isDesktop = this.isElectron;

    // Feature flags
    this.supportsNoorSigner = this.isDesktop;
    this.supportsKeychain = this.isDesktop;
    this.supportsNativeFileDialog = this.isDesktop;
    this.supportsNip07 = this.isBrowser || this.hasNip07Extension();
    this.supportsAmber = this.isCapacitor;

    // CSS platform classes
    if (this.isAndroid) {
      document.documentElement.classList.add('platform--mobile');
    }
    if (this.isCapacitor && this.isAndroid) {
      document.documentElement.classList.add('platform--mobile');
      document.documentElement.classList.add('platform--capacitor-android');
    }
  }

  public static getInstance(): PlatformService {
    if (!PlatformService.instance) {
      PlatformService.instance = new PlatformService();
    }
    return PlatformService.instance;
  }

  private hasNip07Extension(): boolean {
    return typeof window !== 'undefined' && (window as any).nostr !== undefined;
  }

  public checkNip07Available(): boolean {
    return typeof window !== 'undefined' && (window as any).nostr !== undefined;
  }
}
