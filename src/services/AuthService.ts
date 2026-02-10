/**
 * Authentication Service — Coordinator Only
 *
 * Routes authentication, signing, and crypto operations to the active manager.
 * No auth-method business logic lives here — each method is in its own manager:
 *
 * - ExtensionSignerManager  (NIP-07 browser extension, web only)
 * - BunkerSignerManager     (NIP-46 bunker:// URI)
 * - NostrConnectSignerManager (NIP-46 nostrconnect:// QR)
 * - KeySignerConnectionManager (NoorSigner daemon, Tauri only)
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { calculateEventHash, decodeNip19, type UnsignedEvent } from './NostrToolsAdapter';
import { KeychainStorage } from './KeychainStorage';
import { EventBus } from './EventBus';
import { AccountStorageService, type StoredAccount } from './AccountStorageService';
import { PlatformService } from './PlatformService';
import { PerAccountListStorageMigration } from './PerAccountListStorageMigration';

// Managers
import { ExtensionSignerManager } from './managers/ExtensionSignerManager';
import { BunkerSignerManager } from './managers/BunkerSignerManager';
import { NostrConnectSignerManager } from './managers/NostrConnectSignerManager';
import { KeySignerConnectionManager } from './managers/KeySignerConnectionManager';
import type { Nip46BaseManager, NostrConnectSession } from './managers/Nip46BaseManager';

export type AuthMethod = 'npub' | 'extension' | 'nip46' | 'key-signer';
export type InputType = 'npub' | 'bunker' | 'nip05' | 'unknown';

export class AuthService {
  private static instance: AuthService;

  // Managers — one per auth method
  private extensionManager: ExtensionSignerManager | null = null;
  private bunkerManager: BunkerSignerManager | null = null;
  private nostrConnectManager: NostrConnectSignerManager | null = null;
  private keySignerManager: KeySignerConnectionManager | null = null;

  // State
  private currentUser: { npub: string; pubkey: string } | null = null;
  private authMethod: AuthMethod | null = null;
  private isReadOnly: boolean = false;
  private nip46SubType: 'bunker' | 'nostrconnect' | null = null;
  private readonly storageKey = 'noornote_auth_session';
  private eventBus: EventBus;
  private accountStorage: AccountStorageService;

  // Initialization
  private isInitialized: boolean = false;
  private initResolve: (() => void) | null = null;
  private initPromise: Promise<void>;

  private constructor() {
    this.eventBus = EventBus.getInstance();
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
    if (this.nostrConnectManager?.isAvailable()) return this.nostrConnectManager;
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
    if (!PlatformService.getInstance().isTauri) return;

    this.keySignerManager = new KeySignerConnectionManager();
    this.keySignerManager.onConnectionLost(() => {
      console.log('[AuthService] KeySigner connection lost - logging out');
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

  public async authenticateWithInput(input: string): Promise<{ success: boolean; npub?: string; pubkey?: string; error?: string; readOnly?: boolean }> {
    const inputType = this.detectInputType(input);
    switch (inputType) {
      case 'npub': return this.authenticateWithNpub(input);
      case 'bunker': return this.authenticateWithBunker(input);
      case 'nip05': return { success: false, error: 'NIP-05 lookup support coming soon' };
      default: return { success: false, error: 'Invalid input. Please enter npub or bunker:// URI' };
    }
  }

  // ── Extension (NIP-07) ────────────────────────────────────────────

  public isExtensionAvailable(): boolean {
    if (!this.extensionManager) this.extensionManager = new ExtensionSignerManager();
    return this.extensionManager.isAvailable();
  }

  public getExtensionName(): string {
    if (!this.extensionManager) this.extensionManager = new ExtensionSignerManager();
    return this.extensionManager.getExtensionName();
  }

  public async authenticate(): Promise<{ success: boolean; npub?: string; pubkey?: string; error?: string }> {
    if (!this.extensionManager) this.extensionManager = new ExtensionSignerManager();

    const result = await this.extensionManager.authenticate();
    if (result.success && result.npub && result.pubkey) {
      this.setSession(result.npub, result.pubkey, 'extension');
    }
    return result;
  }

  public async restoreExtensionConnection(): Promise<boolean> {
    if (!this.currentUser) return false;
    if (!this.extensionManager) this.extensionManager = new ExtensionSignerManager();
    return this.extensionManager.restoreConnection();
  }

  // ── Bunker (NIP-46) ──────────────────────────────────────────────

  public async authenticateWithBunker(bunkerUri: string): Promise<{ success: boolean; npub?: string; pubkey?: string; error?: string }> {
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

      const { SystemLogger } = await import('../components/system/SystemLogger');
      const { ToastService } = await import('./ToastService');
      SystemLogger.getInstance().info('Auth', 'Login with Remote Signer: successful');
      ToastService.show('Login with Remote Signer: successful', 'success');
    }
    return result;
  }

  // ── NostrConnect QR (NIP-46) ──────────────────────────────────────

  public async startNostrConnect(): Promise<NostrConnectSession> {
    if (!this.nostrConnectManager) this.nostrConnectManager = new NostrConnectSignerManager();

    const session = await this.nostrConnectManager.startNostrConnect();

    const originalWait = session.waitForConnection;
    const wrappedWait = async () => {
      const result = await originalWait();
      if (result.success && result.npub && result.pubkey) {
        this.nip46SubType = 'nostrconnect';
        this.setSession(result.npub, result.pubkey, 'nip46');

        const { SystemLogger } = await import('../components/system/SystemLogger');
        const { ToastService } = await import('./ToastService');
        SystemLogger.getInstance().info('Auth', 'Login with Remote Signer (QR): successful');
        ToastService.show('Connected to remote signer', 'success');
      }
      return result;
    };

    return { uri: session.uri, waitForConnection: wrappedWait, cancel: session.cancel };
  }

  // ── KeySigner (NoorSigner) ────────────────────────────────────────

  public async authenticateWithKeySigner(): Promise<{
    success: boolean; npub?: string; pubkey?: string; error?: string;
    needsPassword?: boolean; needsImport?: boolean;
  }> {
    if (!this.keySignerManager) {
      return { success: false, error: 'KeySigner is only available in Tauri desktop app' };
    }

    try {
      const result = await this.keySignerManager.authenticate();

      if (result.needsPassword || result.needsImport) return result;

      if (result.success && result.npub && result.pubkey) {
        this.currentUser = { npub: result.npub, pubkey: result.pubkey };
        this.authMethod = 'key-signer';
        // NO saveSession() — daemon is single source of truth
        this.saveToAccountStorage();
        this.eventBus.emit('user:login', { npub: result.npub, pubkey: result.pubkey });
        return { success: true, npub: result.npub, pubkey: result.pubkey };
      }

      return result;
    } catch (error) {
      console.error('[AuthService] KeySigner authentication failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'KeySigner authentication failed' };
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
        this.eventBus.emit('user:login', { npub: result.npub, pubkey: result.pubkey });
      }
    } catch {
      // Silent fail — user can manually login
    }
  }

  // ── npub (read-only) ─────────────────────────────────────────────

  public async authenticateWithNpub(npub: string): Promise<{ success: boolean; npub?: string; pubkey?: string; error?: string; readOnly?: boolean }> {
    try {
      if (!npub.startsWith('npub1')) {
        return { success: false, error: 'Invalid npub format. Must start with npub1' };
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
      return { success: false, error: error instanceof Error ? error.message : 'Invalid npub key' };
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // Signing & Crypto (routed to active manager)
  // ══════════════════════════════════════════════════════════════════

  public async signEvent(event: any): Promise<any> {
    if (this.isReadOnly) {
      throw new Error('Cannot sign events in read-only mode (npub login). Please use KeySigner or browser extension for write access.');
    }

    // Add client tag
    if (!event.tags?.some((tag: string[]) => tag[0] === 'client')) {
      if (!event.tags) event.tags = [];
      const clientName = PlatformService.getInstance().isTauri ? 'NoorNote (d)' : 'NoorNote (w)';
      event.tags.push(['client', clientName]);
    }

    try {
      if (this.authMethod === 'extension' && this.extensionManager?.isSignerAvailable()) {
        return await this.extensionManager.signEvent(event);

      } else if (this.authMethod === 'key-signer' && this.keySignerManager) {
        const keySigner = this.keySignerManager.getClient();
        if (!keySigner) throw new Error('KeySigner client not available');

        event.pubkey = this.currentUser!.pubkey;
        event.id = calculateEventHash(event as UnsignedEvent);
        const signature = await keySigner.signEvent(event);
        event.sig = signature;

        const { verifyEventSignature } = await import('./NostrToolsAdapter');
        if (!verifyEventSignature(event as NostrEvent)) {
          throw new Error('KeySigner returned invalid signature - hash mismatch');
        }
        return event;

      } else if (this.authMethod === 'nip46' && this.activeNip46Manager?.isAvailable()) {
        event.pubkey = this.currentUser!.pubkey;
        const signature = await this.activeNip46Manager.signEvent(event);
        event.id = calculateEventHash(event as UnsignedEvent);
        event.sig = signature;
        return event;

      } else {
        throw new Error('No signing method available');
      }
    } catch (error) {
      console.error('AuthService signing error:', error);
      throw error;
    }
  }

  public async nip44Encrypt(plaintext: string, recipientPubkey: string): Promise<string> {
    return this.performCryptoOperation('nip44', 'encrypt', plaintext, recipientPubkey);
  }

  public async nip44Decrypt(ciphertext: string, senderPubkey: string): Promise<string> {
    return this.performCryptoOperation('nip44', 'decrypt', ciphertext, senderPubkey);
  }

  public async nip04Encrypt(plaintext: string, recipientPubkey: string): Promise<string> {
    return this.performCryptoOperation('nip04', 'encrypt', plaintext, recipientPubkey);
  }

  public async nip04Decrypt(ciphertext: string, senderPubkey: string): Promise<string> {
    return this.performCryptoOperation('nip04', 'decrypt', ciphertext, senderPubkey);
  }

  private async performCryptoOperation(
    nip: 'nip04' | 'nip44',
    operation: 'encrypt' | 'decrypt',
    data: string,
    pubkey: string
  ): Promise<string> {
    if (this.isReadOnly) throw new Error(`Cannot ${operation} in read-only mode (npub login)`);

    const methodName = `${nip}${operation.charAt(0).toUpperCase()}${operation.slice(1)}` as
      'nip44Encrypt' | 'nip44Decrypt' | 'nip04Encrypt' | 'nip04Decrypt';

    try {
      if (this.authMethod === 'extension' && this.extensionManager?.isSignerAvailable()) {
        return await this.extensionManager[methodName](data, pubkey);
      }

      if (this.authMethod === 'key-signer' && this.keySignerManager) {
        const keySigner = this.keySignerManager.getClient();
        if (!keySigner) throw new Error('KeySigner client not available');
        return await keySigner[methodName](data, pubkey);
      }

      if (this.authMethod === 'nip46' && this.activeNip46Manager) {
        return await this.activeNip46Manager[methodName](data, pubkey);
      }

      throw new Error(`No ${operation}ion method available`);
    } catch (error) {
      console.error(`${nip.toUpperCase()} ${operation} error:`, error);
      throw error;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // Session Management
  // ══════════════════════════════════════════════════════════════════

  public getCurrentUser(): { npub: string; pubkey: string } | null {
    return this.currentUser;
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
  private setSession(npub: string, pubkey: string, method: AuthMethod, bunkerUri?: string): void {
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
          console.log('[AuthService] NoorSigner daemon stopped');
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
  }

  private async askStopDaemon(): Promise<boolean> {
    const STORAGE_KEY = 'noornote_quit_key_signer_preference';
    const STORAGE_KEY_REMEMBER = 'noornote_quit_key_signer_remember';

    const remember = localStorage.getItem(STORAGE_KEY_REMEMBER) === 'true';
    if (remember) {
      return localStorage.getItem(STORAGE_KEY) === 'true';
    }

    return new Promise(async (resolve) => {
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

      const quitSignerCheckbox = content.querySelector('#quit-signer-checkbox') as HTMLInputElement;
      const rememberCheckbox = content.querySelector('#remember-checkbox') as HTMLInputElement;
      const quitBtn = content.querySelector('[data-action="quit"]') as HTMLButtonElement;
      const cancelBtn = content.querySelector('[data-action="cancel"]') as HTMLButtonElement;

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
        showCloseButton: true
      });
    });
  }

  private async loadSession(): Promise<void> {
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (!stored) return;

      const sessionData = JSON.parse(stored);
      if (!sessionData.npub || !sessionData.pubkey || !sessionData.timestamp || !sessionData.authMethod) return;

      // key-signer sessions are IGNORED — daemon is single source of truth
      if (sessionData.authMethod === 'key-signer') {
        localStorage.removeItem(this.storageKey);
        return;
      }

      const sessionAge = Date.now() - sessionData.timestamp;
      const platform = PlatformService.getInstance();
      const maxAge = platform.isTauri ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;

      if (sessionAge >= maxAge) {
        this.clearSession();
        return;
      }

      this.currentUser = { npub: sessionData.npub, pubkey: sessionData.pubkey };
      this.authMethod = sessionData.authMethod;
      this.isReadOnly = sessionData.isReadOnly || false;
      this.nip46SubType = sessionData.nip46SubType || null;

      // Restore signer connections BEFORE emitting login event
      if (this.authMethod === 'nip46' && this.nip46SubType === 'bunker') {
        if (!this.bunkerManager) this.bunkerManager = new BunkerSignerManager();
        await this.bunkerManager.restoreSession();
      } else if (this.authMethod === 'nip46' && this.nip46SubType === 'nostrconnect') {
        if (!this.nostrConnectManager) this.nostrConnectManager = new NostrConnectSignerManager();
        await this.nostrConnectManager.restoreSession();
      } else if (this.authMethod === 'extension') {
        if (!this.extensionManager) this.extensionManager = new ExtensionSignerManager();
        const restored = await this.extensionManager.restoreConnection();
        if (!restored) {
          console.warn('[AuthService] Extension session could not be restored');
          this.currentUser = null;
          this.authMethod = null;
          this.isReadOnly = false;
          return;
        }
      }

      this.eventBus.emit('user:login', { npub: sessionData.npub, pubkey: sessionData.pubkey });
    } catch (error) {
      console.warn('Failed to load session:', error);
      this.clearSession();
    }
  }

  private saveSession(): void {
    if (!this.currentUser || !this.authMethod) return;
    if (this.authMethod === 'key-signer') return;

    try {
      localStorage.setItem(this.storageKey, JSON.stringify({
        npub: this.currentUser.npub,
        pubkey: this.currentUser.pubkey,
        authMethod: this.authMethod,
        isReadOnly: this.isReadOnly,
        nip46SubType: this.nip46SubType,
        timestamp: Date.now()
      }));
    } catch (error) {
      console.warn('Failed to save session:', error);
    }
  }

  private clearSession(): void {
    try { localStorage.removeItem(this.storageKey); } catch {}
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

  public async switchAccount(pubkey: string): Promise<{ success: boolean; error?: string }> {
    const account = this.accountStorage.getAccount(pubkey);
    if (!account) return { success: false, error: 'Account not found' };

    await this.signOutWithoutDaemonStop();

    let result: { success: boolean; error?: string };
    switch (account.authMethod) {
      case 'extension':
        result = await this.authenticate();
        break;
      case 'nip46':
        if (!account.bunkerUri) return { success: false, error: 'No bunker URI stored for this account' };
        result = await this.authenticateWithBunker(account.bunkerUri);
        break;
      case 'key-signer':
        result = await this.authenticateWithKeySigner();
        break;
      default:
        return { success: false, error: `Unsupported auth method: ${account.authMethod}` };
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
      lastUsedAt: Date.now()
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
