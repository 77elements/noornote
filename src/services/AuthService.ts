/**
 * Authentication Service — Coordinator Only
 *
 * Routes authentication, signing, and crypto operations to the active manager.
 * No auth-method business logic lives here — each method is in its own manager:
 *
 * - ExtensionSignerManager  (NIP-07 browser extension, web only)
 * - BunkerSignerManager     (NIP-46 bunker:// URI)
 * - NostrConnectSignerManager (NIP-46 nostrconnect:// QR)
 * - KeySignerConnectionManager (NoorSigner daemon, Desktop only)
 * - AmberSignerManager      (NIP-55 Android signer, Android only)
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import {
  calculateEventHash,
  decodeNip19,
  type UnsignedEvent,
} from './NostrToolsAdapter';
import { KeychainStorage } from './KeychainStorage';
import { TypedEventBus } from '../core/TypedEventBus';
import {
  AccountStorageService,
  type StoredAccount,
} from './AccountStorageService';
import { PlatformService } from './PlatformService';
import { PerAccountListStorageMigration } from './PerAccountListStorageMigration';

// Managers
import { ExtensionSignerManager } from './managers/ExtensionSignerManager';
import { BunkerSignerManager } from './managers/BunkerSignerManager';
import { NostrConnectSignerManager } from './managers/NostrConnectSignerManager';
import { KeySignerConnectionManager } from './managers/KeySignerConnectionManager';
import { AmberSignerManager } from './managers/AmberSignerManager';
import type {
  Nip46BaseManager,
  NostrConnectSession,
} from './managers/Nip46BaseManager';

export type AuthMethod =
  | 'npub'
  | 'extension'
  | 'nip46'
  | 'key-signer'
  | 'amber';
export type InputType = 'npub' | 'bunker' | 'nip05' | 'unknown';

export class AuthService {
  private static instance: AuthService;

  // Managers — one per auth method
  private extensionManager: ExtensionSignerManager | null = null;
  private bunkerManager: BunkerSignerManager | null = null;
  private nostrConnectManager: NostrConnectSignerManager | null = null;
  private keySignerManager: KeySignerConnectionManager | null = null;
  private amberManager: AmberSignerManager | null = null;

  // State
  private currentUser: { npub: string; pubkey: string } | null = null;
  private authMethod: AuthMethod | null = null;
  private isReadOnly: boolean = false;
  private nip46SubType: 'bunker' | 'nostrconnect' | null = null;
  private readonly storageKey = 'noornote_auth_session';
  private eventBus: TypedEventBus;
  private accountStorage: AccountStorageService;

  // Initialization
  private isInitialized: boolean = false;
  private initResolve: (() => void) | null = null;
  private initPromise: Promise<void>;

  private constructor() {
    this.eventBus = TypedEventBus.getInstance();
    this.accountStorage = AccountStorageService.getInstance();

    this.initPromise = new Promise<void>(resolve => {
      this.initResolve = resolve;
    });

    this.eventBus.on('user:login', (data: { pubkey: string }) => {
      PerAccountListStorageMigration.getInstance().migrateForUser(data.pubkey);
    });

    this.initializeSession();
  }

  public static getInstance(): AuthService {
    if (!AuthService.instance) {
      AuthService.instance = new AuthService();
    }
    return AuthService.instance;
  }

  public async waitForInitialization(): Promise<void> {
    return this.initPromise;
  }

  public getIsInitialized(): boolean {
    return this.isInitialized;
  }

  // ── Active NIP-46 manager (bunker or nostrconnect) ────────────────

  private get activeNip46Manager(): Nip46BaseManager | null {
    if (this.bunkerManager?.isAvailable()) return this.bunkerManager;
    if (this.nostrConnectManager?.isAvailable())
      return this.nostrConnectManager;
    return null;
  }

  /** Public getter for crypto helpers that access nip46Manager */
  public get nip46Manager(): Nip46BaseManager | null {
    return this.activeNip46Manager;
  }

  // ══════════════════════════════════════════════════════════════════
  // Initialization
  // ══════════════════════════════════════════════════════════════════

  private async initializeSession(): Promise<void> {
    try {
      await this.loadSession();
      this.initializeKeySignerManager();
      await this.tryAutoLoginWithKeySigner();
    } finally {
      this.isInitialized = true;
      this.initResolve?.();
    }
  }

  private initializeKeySignerManager(): void {
    const platform = PlatformService.getInstance();
    if (!platform.isDesktop) return;

    this.keySignerManager = new KeySignerConnectionManager();
    this.keySignerManager.onConnectionLost(() => {
      console.debug('[AuthService] KeySigner connection lost - logging out');
      this.currentUser = null;
      this.authMethod = null;
      this.eventBus.emit('user:logout');
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // Authentication Methods (delegated to managers)
  // ══════════════════════════════════════════════════════════════════

  public detectInputType(input: string): InputType {
    const trimmed = input.trim();
    if (trimmed.startsWith('npub1')) return 'npub';
    if (trimmed.startsWith('bunker://')) return 'bunker';
    if (/^[\w\-\.]+@[\w\-\.]+\.\w+$/.test(trimmed)) return 'nip05';
    return 'unknown';
  }

  public async authenticateWithInput(input: string): Promise<{
    success: boolean;
    npub?: string;
    pubkey?: string;
    error?: string;
    readOnly?: boolean;
  }> {
    const inputType = this.detectInputType(input);
    switch (inputType) {
      case 'npub':
        return this.authenticateWithNpub(input);
      case 'bunker':
        return this.authenticateWithBunker(input);
      case 'nip05':
        return { success: false, error: 'NIP-05 lookup support coming soon' };
      default:
        return {
          success: false,
          error: 'Invalid input. Please enter npub or bunker:// URI',
        };
    }
  }

  // ── Extension (NIP-07) ────────────────────────────────────────────

  public isExtensionAvailable(): boolean {
    if (!this.extensionManager)
      this.extensionManager = new ExtensionSignerManager();
    return this.extensionManager.isAvailable();
  }

  public getExtensionName(): string {
    if (!this.extensionManager)
      this.extensionManager = new ExtensionSignerManager();
    return this.extensionManager.getExtensionName();
  }

  public async authenticate(): Promise<{
    success: boolean;
    npub?: string;
    pubkey?: string;
    error?: string;
  }> {
    if (!this.extensionManager)
      this.extensionManager = new ExtensionSignerManager();

    const result = await this.extensionManager.authenticate();
    if (result.success && result.npub && result.pubkey) {
      this.setSession(result.npub, result.pubkey, 'extension');
    }
    return result;
  }

  public async restoreExtensionConnection(): Promise<boolean> {
    if (!this.currentUser) return false;
    if (!this.extensionManager)
      this.extensionManager = new ExtensionSignerManager();
    return this.extensionManager.restoreConnection();
  }

  // ── Bunker (NIP-46) ──────────────────────────────────────────────

  public async authenticateWithBunker(bunkerUri: string): Promise<{
    success: boolean;
    npub?: string;
    pubkey?: string;
    error?: string;
  }> {
    // Cancel any active nostrconnect flow first
    if (this.nostrConnectManager) {
      this.nostrConnectManager.stop();
      this.nostrConnectManager = null;
    }

    if (!this.bunkerManager) this.bunkerManager = new BunkerSignerManager();

    const result = await this.bunkerManager.authenticate(bunkerUri);
    if (result.success && result.npub && result.pubkey) {
      this.nip46SubType = 'bunker';
      this.setSession(result.npub, result.pubkey, 'nip46', bunkerUri);

      const { SystemLogger } = await import('./SystemLogger');
      const { ToastService } = await import('./ToastService');
      SystemLogger.getInstance().info(
        'Auth',
        'Login with Remote Signer: successful'
      );
      ToastService.show('Login with Remote Signer: successful', 'success');
    }
    return result;
  }

  // ── NostrConnect QR (NIP-46) ──────────────────────────────────────

  public async startNostrConnect(): Promise<NostrConnectSession> {
    if (!this.nostrConnectManager)
      this.nostrConnectManager = new NostrConnectSignerManager();

    const session = await this.nostrConnectManager.startNostrConnect();

    const originalWait = session.waitForConnection;
    const wrappedWait = async () => {
      const result = await originalWait();
      if (result.success && result.npub && result.pubkey) {
        this.nip46SubType = 'nostrconnect';
        this.setSession(result.npub, result.pubkey, 'nip46');

        const { SystemLogger } = await import('./SystemLogger');
        const { ToastService } = await import('./ToastService');
        SystemLogger.getInstance().info(
          'Auth',
          'Login with Remote Signer (QR): successful'
        );
        ToastService.show('Connected to remote signer', 'success');
      }
      return result;
    };

    return {
      uri: session.uri,
      waitForConnection: wrappedWait,
      cancel: session.cancel,
    };
  }

  // ── KeySigner (NoorSigner) ────────────────────────────────────────

  public async authenticateWithKeySigner(): Promise<{
    success: boolean;
    npub?: string;
    pubkey?: string;
    error?: string;
    needsPassword?: boolean;
    needsImport?: boolean;
  }> {
    if (!this.keySignerManager) {
      return {
        success: false,
        error: 'KeySigner is only available in desktop app',
      };
    }

    try {
      const result = await this.keySignerManager.authenticate();

      if (result.needsPassword || result.needsImport) return result;

      if (result.success && result.npub && result.pubkey) {
        this.currentUser = { npub: result.npub, pubkey: result.pubkey };
        this.authMethod = 'key-signer';
        // NO saveSession() — daemon is single source of truth
        this.saveToAccountStorage();
        this.eventBus.emit('user:login', {
          npub: result.npub,
          pubkey: result.pubkey,
        });
        return { success: true, npub: result.npub, pubkey: result.pubkey };
      }

      return result;
    } catch (error) {
      console.error('[AuthService] KeySigner authentication failed:', error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'KeySigner authentication failed',
      };
    }
  }

  public async cancelKeySignerLogin(): Promise<void> {
    if (this.keySignerManager) await this.keySignerManager.cancelLogin();
  }

  private async tryAutoLoginWithKeySigner(): Promise<void> {
    if (this.currentUser || !this.keySignerManager) return;

    try {
      const result = await this.keySignerManager.tryAutoLogin();
      if (result.success && result.npub && result.pubkey) {
        this.currentUser = { npub: result.npub, pubkey: result.pubkey };
        this.authMethod = 'key-signer';
        this.saveToAccountStorage();
        this.eventBus.emit('user:login', {
          npub: result.npub,
          pubkey: result.pubkey,
        });
      }
    } catch {
      // Silent fail — user can manually login
    }
  }

  // ── Amber (NIP-55, Android) ───────────────────────────────────────

  public async isAmberAvailable(): Promise<boolean> {
    if (!this.amberManager) this.amberManager = new AmberSignerManager();
    return this.amberManager.isAvailable();
  }

  public async authenticateWithAmber(): Promise<{
    success: boolean;
    npub?: string;
    pubkey?: string;
    error?: string;
  }> {
    if (!this.amberManager) this.amberManager = new AmberSignerManager();

    const result = await this.amberManager.authenticate();
    if (result.success && result.npub && result.pubkey) {
      this.setSession(result.npub, result.pubkey, 'amber');
    }
    return result;
  }

  // ── npub (read-only) ─────────────────────────────────────────────

  public async authenticateWithNpub(npub: string): Promise<{
    success: boolean;
    npub?: string;
    pubkey?: string;
    error?: string;
    readOnly?: boolean;
  }> {
    try {
      if (!npub.startsWith('npub1')) {
        return {
          success: false,
          error: 'Invalid npub format. Must start with npub1',
        };
      }

      const decoded = decodeNip19(npub);
      if (decoded.type !== 'npub') {
        return { success: false, error: 'Invalid npub key format' };
      }
      const pubkey = decoded.data as string;

      this.currentUser = { npub, pubkey };
      this.authMethod = 'npub';
      this.isReadOnly = true;
      this.saveSession();
      this.eventBus.emit('user:login', { npub, pubkey });

      return { success: true, npub, pubkey, readOnly: true };
    } catch (error) {
      console.error('npub authentication failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Invalid npub key',
      };
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // Signing & Crypto (routed to active manager)
  // ══════════════════════════════════════════════════════════════════

  public async signEvent(event: any): Promise<any> {
    if (this.isReadOnly) {
      throw new Error(
        'Cannot sign events in read-only mode (npub login). Please use KeySigner or browser extension for write access.'
      );
    }

    // Add client tag (opt-in via UI setting)
    const { isClientTagEnabled } = await import('../helpers/clientTagSetting');
    if (
      isClientTagEnabled() &&
      !event.tags?.some((tag: string[]) => tag[0] === 'client')
    ) {
      if (!event.tags) event.tags = [];
      event.tags.push(['client', 'NoorNote']);
    }

    try {
      if (
        this.authMethod === 'extension' &&
        this.extensionManager?.isSignerAvailable()
      ) {
        return await this.withSignerTimeout(
          this.extensionManager.signEvent(event),
          AuthService.SIGN_TIMEOUT_MS,
          'extension sign'
        );
      } else if (this.authMethod === 'key-signer' && this.keySignerManager) {
        const keySigner = this.keySignerManager.getClient();
        if (!keySigner) throw new Error('KeySigner client not available');

        event.pubkey = this.currentUser!.pubkey;
        event.id = calculateEventHash(event as UnsignedEvent);
        const signature = await keySigner.signEvent(event);
        event.sig = signature;

        const { verifyEventSignature } = await import('./NostrToolsAdapter');
        if (!verifyEventSignature(event as NostrEvent)) {
          throw new Error(
            'KeySigner returned invalid signature - hash mismatch'
          );
        }
        return event;
      } else if (
        this.authMethod === 'nip46' &&
        this.activeNip46Manager?.isAvailable()
      ) {
        event.pubkey = this.currentUser!.pubkey;
        const signature = await this.activeNip46Manager.signEvent(event);
        event.id = calculateEventHash(event as UnsignedEvent);
        event.sig = signature;
        return event;
      } else if (this.authMethod === 'amber' && this.amberManager) {
        event.pubkey = this.currentUser!.pubkey;
        event.created_at = event.created_at || Math.floor(Date.now() / 1000);
        const signedEventJson = await this.withSignerTimeout(
          this.amberManager.signEvent(event),
          AuthService.SIGN_TIMEOUT_MS,
          'amber sign'
        );
        const signedEvent = JSON.parse(signedEventJson);
        return signedEvent;
      } else {
        const disconnectErrors: Record<string, string> = {
          extension: 'Browser extension disconnected — please reload the page',
          nip46: 'Remote signer disconnected — please reconnect',
          'key-signer': 'Key signer not running — please restart NoorSigner',
          amber: 'Amber signer disconnected — please reopen Amber',
        };
        throw new Error(
          (this.authMethod && disconnectErrors[this.authMethod]) ||
            'No signing method available'
        );
      }
    } catch (error) {
      console.error('AuthService signing error:', error);
      throw error;
    }
  }

  /**
   * Sign an event but reject with a SignerTimeoutError if the active signer
   * (NIP-07 extension, NIP-46 bunker, Amber, …) does not respond in time.
   * Prevents the publish flow from hanging forever on a dead/hung signer.
   */
  public async signEventWithTimeout(
    event: any,
    timeoutMs: number = AuthService.SIGN_TIMEOUT_MS
  ): Promise<any> {
    const { SignerTimeoutError } = await import('./SignerTimeoutError');
    return Promise.race([
      this.signEvent(event),
      new Promise((_, reject) =>
        setTimeout(() => reject(new SignerTimeoutError()), timeoutMs)
      ),
    ]);
  }

  /**
   * Wrap a signer/crypto promise so a dead or hung NIP-07 extension / Amber
   * signer rejects with SignerTimeoutError instead of hanging the flow forever.
   * NIP-46 (own RPC timeout + circuit breaker) and KeySigner (daemon health
   * polling) already protect themselves, so only those two branches use this.
   */
  private static readonly SIGN_TIMEOUT_MS = 30000;
  private static readonly CRYPTO_TIMEOUT_MS = 20000;

  private async withSignerTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    operation: string
  ): Promise<T> {
    const { SignerTimeoutError } = await import('./SignerTimeoutError');
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new SignerTimeoutError(
              `Signer did not respond in time (${operation})`
            )
          ),
        timeoutMs
      );
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  public async nip44Encrypt(
    plaintext: string,
    recipientPubkey: string
  ): Promise<string> {
    return this.performCryptoOperation(
      'nip44',
      'encrypt',
      plaintext,
      recipientPubkey
    );
  }

  public async nip44Decrypt(
    ciphertext: string,
    senderPubkey: string
  ): Promise<string> {
    return this.performCryptoOperation(
      'nip44',
      'decrypt',
      ciphertext,
      senderPubkey
    );
  }

  public async nip04Encrypt(
    plaintext: string,
    recipientPubkey: string
  ): Promise<string> {
    return this.performCryptoOperation(
      'nip04',
      'encrypt',
      plaintext,
      recipientPubkey
    );
  }

  public async nip04Decrypt(
    ciphertext: string,
    senderPubkey: string
  ): Promise<string> {
    return this.performCryptoOperation(
      'nip04',
      'decrypt',
      ciphertext,
      senderPubkey
    );
  }

  private async performCryptoOperation(
    nip: 'nip04' | 'nip44',
    operation: 'encrypt' | 'decrypt',
    data: string,
    pubkey: string
  ): Promise<string> {
    if (this.isReadOnly)
      throw new Error(`Cannot ${operation} in read-only mode (npub login)`);

    const methodName =
      `${nip}${operation.charAt(0).toUpperCase()}${operation.slice(1)}` as
        | 'nip44Encrypt'
        | 'nip44Decrypt'
        | 'nip04Encrypt'
        | 'nip04Decrypt';

    try {
      if (
        this.authMethod === 'extension' &&
        this.extensionManager?.isSignerAvailable()
      ) {
        return await this.withSignerTimeout(
          this.extensionManager[methodName](data, pubkey),
          AuthService.CRYPTO_TIMEOUT_MS,
          `extension ${methodName}`
        );
      }

      if (this.authMethod === 'key-signer' && this.keySignerManager) {
        const keySigner = this.keySignerManager.getClient();
        if (!keySigner) throw new Error('KeySigner client not available');
        return await keySigner[methodName](data, pubkey);
      }

      if (this.authMethod === 'nip46' && this.activeNip46Manager) {
        return await this.activeNip46Manager[methodName](data, pubkey);
      }

      if (this.authMethod === 'amber' && this.amberManager) {
        return await this.withSignerTimeout(
          this.amberManager[methodName](data, pubkey),
          AuthService.CRYPTO_TIMEOUT_MS,
          `amber ${methodName}`
        );
      }

      throw new Error(`No ${operation}ion method available`);
    } catch (error) {
      throw error;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // Session Management
  // ══════════════════════════════════════════════════════════════════

  public getCurrentUser(): { npub: string; pubkey: string } | null {
    return this.currentUser;
  }

  /**
   * Check if a given pubkey belongs to the currently logged-in user.
   * Replaces the repeated `getCurrentUser()?.pubkey === pubkey` pattern.
   */
  public isCurrentUser(pubkey: string): boolean {
    return this.currentUser?.pubkey === pubkey;
  }

  public isReadOnlyMode(): boolean {
    return this.isReadOnly;
  }

  public hasValidSession(): boolean {
    return this.currentUser !== null;
  }

  public getAuthMethod(): AuthMethod | null {
    return this.authMethod;
  }

  public isBunkerAuth(): boolean {
    return this.authMethod === 'nip46' && this.nip46SubType === 'bunker';
  }

  /**
   * Common helper: set session state after successful auth
   */
  private setSession(
    npub: string,
    pubkey: string,
    method: AuthMethod,
    bunkerUri?: string
  ): void {
    this.currentUser = { npub, pubkey };
    this.authMethod = method;
    this.isReadOnly = false;
    this.saveSession();
    this.saveToAccountStorage(bunkerUri);
    this.eventBus.emit('user:login', { npub, pubkey });
  }

  public async signOut(): Promise<void> {
    let shouldStopDaemon = false;

    if (this.authMethod === 'key-signer' && this.keySignerManager) {
      shouldStopDaemon = await this.askStopDaemon();
    }

    if (this.keySignerManager) this.keySignerManager.stopDaemonPolling();

    this.cleanupManagers();

    this.currentUser = null;
    this.authMethod = null;
    this.isReadOnly = false;

    await KeychainStorage.clearAuth();
    this.clearSession();
    this.eventBus.emit('user:logout');

    if (shouldStopDaemon && this.keySignerManager) {
      const keySigner = this.keySignerManager.getClient();
      if (keySigner) {
        try {
          await keySigner.stopDaemon();
          console.debug('[AuthService] NoorSigner daemon stopped');
          const { ToastService } = await import('./ToastService');
          ToastService.show('Key signer stopped', 'success');
        } catch (error) {
          console.warn('[AuthService] Failed to stop daemon:', error);
          const { ToastService } = await import('./ToastService');
          ToastService.show('Failed to stop key signer', 'error');
        }
      }
      this.keySignerManager.clear();
    }
  }

  private cleanupManagers(): void {
    if (this.extensionManager) {
      this.extensionManager.cleanup();
      this.extensionManager = null;
    }
    if (this.bunkerManager) {
      this.bunkerManager.cleanup();
      this.bunkerManager = null;
    }
    if (this.nostrConnectManager) {
      this.nostrConnectManager.cleanup();
      this.nostrConnectManager = null;
    }
    if (this.amberManager) {
      this.amberManager.cleanup();
      this.amberManager = null;
    }
  }

  private async askStopDaemon(): Promise<boolean> {
    const STORAGE_KEY = 'noornote_quit_key_signer_preference';
    const STORAGE_KEY_REMEMBER = 'noornote_quit_key_signer_remember';

    const remember = localStorage.getItem(STORAGE_KEY_REMEMBER) === 'true';
    if (remember) {
      return localStorage.getItem(STORAGE_KEY) === 'true';
    }

    return new Promise(async resolve => {
      const { ModalService } = await import('./ModalService');
      const modalService = ModalService.getInstance();

      const lastPreference = localStorage.getItem(STORAGE_KEY) === 'true';

      const content = document.createElement('div');
      content.style.cssText = 'padding: 1rem;';
      content.innerHTML = `
        <p style="margin-bottom: 1.5rem; line-height: 1.5; text-align: center;">
          Do you want to quit the Key Signer as well?<br>
          If you keep it running, you can log back in without entering your password.
        </p>
        <div style="margin-bottom: 1.5rem;">
          <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; margin-bottom: 0.75rem;">
            <input type="checkbox" id="quit-signer-checkbox" ${lastPreference ? 'checked' : ''}>
            <span>Quit Key Signer as well?</span>
          </label>
          <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
            <input type="checkbox" id="remember-checkbox">
            <span>Remember and don't ask again</span>
          </label>
        </div>
        <div style="display: flex; gap: 1rem; justify-content: center;">
          <button class="btn btn--passive" data-action="cancel">Cancel</button>
          <button class="btn" data-action="quit" style="min-width: 200px;">Quit NoorNote</button>
        </div>
      `;

      const quitSignerCheckbox = content.querySelector(
        '#quit-signer-checkbox'
      ) as HTMLInputElement;
      const rememberCheckbox = content.querySelector(
        '#remember-checkbox'
      ) as HTMLInputElement;
      const quitBtn = content.querySelector(
        '[data-action="quit"]'
      ) as HTMLButtonElement;
      const cancelBtn = content.querySelector(
        '[data-action="cancel"]'
      ) as HTMLButtonElement;

      const updateButtonText = () => {
        quitBtn.textContent = quitSignerCheckbox.checked
          ? 'Quit NoorNote & Key Signer'
          : 'Quit NoorNote';
      };

      quitSignerCheckbox.addEventListener('change', updateButtonText);
      updateButtonText();

      quitBtn.addEventListener('click', () => {
        const quitSigner = quitSignerCheckbox.checked;
        localStorage.setItem(STORAGE_KEY, quitSigner.toString());
        if (rememberCheckbox.checked) {
          localStorage.setItem(STORAGE_KEY_REMEMBER, 'true');
        } else {
          localStorage.removeItem(STORAGE_KEY_REMEMBER);
        }
        modalService.hide();
        resolve(quitSigner);
      });

      cancelBtn.addEventListener('click', () => {
        modalService.hide();
      });

      modalService.show({
        title: 'Quit NoorNote & Key Signer?',
        content,
        width: '450px',
        height: 'auto',
        closeOnOverlay: true,
        closeOnEsc: true,
        showCloseButton: true,
      });
    });
  }

  /**
   * Reset session state when a signer connection cannot be restored.
   */
  private invalidateSession(): void {
    console.debug('[AuthService] Signer session could not be restored');
    this.currentUser = null;
    this.authMethod = null;
    this.isReadOnly = false;
  }

  /**
   * Restore the active signer connection based on current auth method.
   * Returns true if the connection was restored (or no restore needed).
   */
  private async restoreSignerConnection(): Promise<boolean> {
    if (this.authMethod === 'nip46' && this.nip46SubType === 'bunker') {
      if (!this.bunkerManager) this.bunkerManager = new BunkerSignerManager();
      await this.bunkerManager.restoreSession();
      return this.bunkerManager.isAvailable();
    }

    if (this.authMethod === 'nip46' && this.nip46SubType === 'nostrconnect') {
      if (!this.nostrConnectManager)
        this.nostrConnectManager = new NostrConnectSignerManager();
      await this.nostrConnectManager.restoreSession();
      return this.nostrConnectManager.isAvailable();
    }

    if (this.authMethod === 'extension') {
      if (!this.extensionManager)
        this.extensionManager = new ExtensionSignerManager();
      return this.extensionManager.restoreConnection();
    }

    if (this.authMethod === 'amber') {
      if (!this.amberManager) this.amberManager = new AmberSignerManager();
      return this.amberManager.restoreSession();
    }

    return true;
  }

  private async loadSession(): Promise<void> {
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (!stored) return;

      const sessionData = JSON.parse(stored);
      if (
        !sessionData.npub ||
        !sessionData.pubkey ||
        !sessionData.timestamp ||
        !sessionData.authMethod
      )
        return;

      // key-signer sessions are IGNORED — daemon is single source of truth
      if (sessionData.authMethod === 'key-signer') {
        localStorage.removeItem(this.storageKey);
        return;
      }

      const sessionAge = Date.now() - sessionData.timestamp;
      const maxAge = 30 * 24 * 60 * 60 * 1000;

      if (sessionAge >= maxAge) {
        this.clearSession();
        return;
      }

      this.currentUser = { npub: sessionData.npub, pubkey: sessionData.pubkey };
      this.authMethod = sessionData.authMethod;
      this.isReadOnly = sessionData.isReadOnly || false;
      this.nip46SubType = sessionData.nip46SubType || null;

      // Legacy guard: old sessions (≤0.4.7) lack nip46SubType — clear and re-login
      if (this.authMethod === 'nip46' && !this.nip46SubType) {
        console.warn(
          '[AuthService] Legacy NIP-46 session without subType — clearing'
        );
        this.clearSession();
        return;
      }

      // Restore signer connections BEFORE emitting login event.
      // NIP-46: restoreSession() keeps signer alive even if remote signer is offline
      // (lazy reconnect via guardRpcReady on first sign/encrypt). Only log out if
      // signer creation itself failed (corrupted payload → isAvailable() = false).
      const restored = await this.restoreSignerConnection();
      if (!restored) {
        this.invalidateSession();
        return;
      }

      this.eventBus.emit('user:login', {
        npub: sessionData.npub,
        pubkey: sessionData.pubkey,
      });
    } catch (error) {
      console.warn('Failed to load session:', error);
      this.clearSession();
    }
  }

  private saveSession(): void {
    if (!this.currentUser || !this.authMethod) return;
    if (this.authMethod === 'key-signer') return;

    try {
      localStorage.setItem(
        this.storageKey,
        JSON.stringify({
          npub: this.currentUser.npub,
          pubkey: this.currentUser.pubkey,
          authMethod: this.authMethod,
          isReadOnly: this.isReadOnly,
          nip46SubType: this.nip46SubType,
          timestamp: Date.now(),
        })
      );
    } catch (error) {
      console.warn('Failed to save session:', error);
    }
  }

  private clearSession(): void {
    try {
      localStorage.removeItem(this.storageKey);
    } catch {
      /* ignore */
    }
    this.currentUser = null;
    this.authMethod = null;
    this.isReadOnly = false;
    this.nip46SubType = null;
    this.cleanupManagers();
  }

  // ══════════════════════════════════════════════════════════════════
  // Multi-Account Support
  // ══════════════════════════════════════════════════════════════════

  public getStoredAccounts(): StoredAccount[] {
    return this.accountStorage.getAccounts();
  }

  public async switchAccount(
    pubkey: string
  ): Promise<{ success: boolean; error?: string }> {
    const account = this.accountStorage.getAccount(pubkey);
    if (!account) return { success: false, error: 'Account not found' };

    await this.signOutWithoutDaemonStop();

    let result: { success: boolean; error?: string };
    switch (account.authMethod) {
      case 'extension':
        result = await this.authenticate();
        break;
      case 'nip46':
        if (!account.bunkerUri)
          return {
            success: false,
            error: 'No bunker URI stored for this account',
          };
        result = await this.authenticateWithBunker(account.bunkerUri);
        break;
      case 'key-signer':
        result = await this.authenticateWithKeySigner();
        break;
      case 'amber':
        result = await this.authenticateWithAmber();
        break;
      default:
        return {
          success: false,
          error: `Unsupported auth method: ${account.authMethod}`,
        };
    }

    if (result.success) this.accountStorage.touchAccount(pubkey);
    return result;
  }

  private async signOutWithoutDaemonStop(): Promise<void> {
    if (this.keySignerManager) this.keySignerManager.stopDaemonPolling();
    this.cleanupManagers();

    this.currentUser = null;
    this.authMethod = null;
    this.isReadOnly = false;

    await KeychainStorage.clearAuth();
    this.clearSession();
    this.eventBus.emit('user:logout');
  }

  public async removeStoredAccount(pubkey: string): Promise<void> {
    if (this.currentUser?.pubkey === pubkey) await this.signOut();
    this.accountStorage.removeAccount(pubkey);
  }

  public async signOutAll(): Promise<void> {
    await this.signOut();
    this.accountStorage.clearAll();
  }

  private saveToAccountStorage(bunkerUri?: string): void {
    if (!this.currentUser || !this.authMethod) return;

    const account: StoredAccount = {
      pubkey: this.currentUser.pubkey,
      npub: this.currentUser.npub,
      authMethod: this.authMethod,
      addedAt: Date.now(),
      lastUsedAt: Date.now(),
    };

    if (bunkerUri) account.bunkerUri = bunkerUri;
    this.accountStorage.addAccount(account);
  }

  // ── Deprecated getters (keep for backward compatibility) ──────────

  /** @deprecated Use extensionManager directly */
  public getExtension(): any {
    return this.extensionManager?.isSignerAvailable() ? window.nostr : null;
  }
}
