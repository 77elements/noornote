/**
 * Authentication Service
 * Handles authentication via:
 * 1. Direct nsec input (Keychain/localStorage)
 * 2. Browser extension (NIP-07) - web only
 * 3. Remote signer (NIP-46) - bunker://
 */

import { hexToNpub } from '../helpers/nip19';
import {
  getPublicKeyFromPrivate,
  calculateEventHash,
  finalizeEventSigning,
  decodeNip19,
  type UnsignedEvent
} from './NostrToolsAdapter';
import { KeychainStorage } from './KeychainStorage';
import { EventBus } from './EventBus';
import { AccountStorageService, type StoredAccount } from './AccountStorageService';
import { KeySignerConnectionManager } from './managers/KeySignerConnectionManager';
import { Nip46SignerManager } from './managers/Nip46SignerManager';
import { PlatformService } from './PlatformService';
import { PerAccountListStorageMigration } from './PerAccountListStorageMigration';

export interface NostrExtension {
  getPublicKey(): Promise<string>;
  signEvent(event: any): Promise<any>;
  nip04?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
}

declare global {
  interface Window {
    nostr?: NostrExtension;
  }
}

export type AuthMethod = 'nsec' | 'npub' | 'extension' | 'nip46' | 'key-signer';
export type InputType = 'nsec' | 'npub' | 'bunker' | 'nip05' | 'unknown';

export class AuthService {
  private static instance: AuthService;
  private extension: NostrExtension | null = null;
  private nsec: string | null = null; // Private key (only when using direct nsec)
  private keySignerManager: KeySignerConnectionManager | null = null; // KeySigner connection manager
  private nip46Manager: Nip46SignerManager | null = null; // NIP-46 remote signer manager
  private currentUser: { npub: string; pubkey: string } | null = null;
  private authMethod: AuthMethod | null = null;
  private isReadOnly: boolean = false; // True when logged in with npub only
  private readonly storageKey = 'noornote_auth_session';
  private eventBus: EventBus;
  private accountStorage: AccountStorageService;

  // Initialization state (like Jumble's isInitialized pattern)
  private isInitialized: boolean = false;
  private initResolve: (() => void) | null = null;
  private initPromise: Promise<void>;

  private constructor() {
    this.eventBus = EventBus.getInstance();
    this.accountStorage = AccountStorageService.getInstance();

    // Create initialization promise
    this.initPromise = new Promise<void>(resolve => {
      this.initResolve = resolve;
    });

    // Listen for login to trigger per-account storage migration
    this.eventBus.on('user:login', (data: { pubkey: string }) => {
      const migration = PerAccountListStorageMigration.getInstance();
      migration.migrateForUser(data.pubkey);
    });

    // Initialize session (async)
    this.initializeSession();
  }

  /**
   * Initialize session - handles async restore operations properly
   */
  private async initializeSession(): Promise<void> {
    try {
      await this.loadSession();

      // Initialize KeySigner connection manager
      this.initializeKeySignerManager();

      // Try auto-login with KeySigner if no session and in Tauri
      await this.tryAutoLoginWithKeySigner();
    } finally {
      // Mark as initialized regardless of success/failure
      this.isInitialized = true;
      this.initResolve?.();
    }
  }

  /**
   * Wait for auth service to be fully initialized
   * Use this before accessing auth state in components
   */
  public async waitForInitialization(): Promise<void> {
    return this.initPromise;
  }

  /**
   * Check if auth service is initialized
   */
  public getIsInitialized(): boolean {
    return this.isInitialized;
  }

  public static getInstance(): AuthService {
    if (!AuthService.instance) {
      AuthService.instance = new AuthService();
    }
    return AuthService.instance;
  }

  /**
   * Initialize KeySigner connection manager and setup event listeners
   */
  private initializeKeySignerManager(): void {
    if (!PlatformService.getInstance().isTauri) return;

    this.keySignerManager = new KeySignerConnectionManager();

    // Listen for connection lost events
    this.keySignerManager.onConnectionLost(() => {
      console.log('[AuthService] KeySigner connection lost - logging out');
      this.handleKeySignerConnectionLost();
    });
  }

  /**
   * Handle KeySigner connection lost (auto-logout)
   */
  private async handleKeySignerConnectionLost(): Promise<void> {
    // Clear session
    this.currentUser = null;
    this.authMethod = null;

    // Emit logout event
    this.eventBus.emit('user:logout');
  }

  /**
   * Detect input type from user input
   */
  public detectInputType(input: string): InputType {
    const trimmed = input.trim();

    if (trimmed.startsWith('nsec1')) {
      return 'nsec';
    }

    if (trimmed.startsWith('npub1')) {
      return 'npub';
    }

    if (trimmed.startsWith('bunker://')) {
      return 'bunker';
    }

    // NIP-05: username@domain.com
    if (/^[\w\-\.]+@[\w\-\.]+\.\w+$/.test(trimmed)) {
      return 'nip05';
    }

    return 'unknown';
  }

  /**
   * Smart authenticate - detects input type and authenticates accordingly
   */
  public async authenticateWithInput(input: string): Promise<{ success: boolean; npub?: string; pubkey?: string; error?: string; readOnly?: boolean }> {
    const inputType = this.detectInputType(input);

    switch (inputType) {
      case 'nsec':
        return this.authenticateWithNsec(input);

      case 'npub':
        return this.authenticateWithNpub(input);

      case 'bunker':
        return this.authenticateWithBunker(input);

      case 'nip05':
        return {
          success: false,
          error: 'NIP-05 lookup support coming soon'
        };

      default:
        return {
          success: false,
          error: 'Invalid input. Please enter npub, nsec, or bunker:// URI'
        };
    }
  }

  /**
   * Check if a Nostr extension is available
   */
  public isExtensionAvailable(): boolean {
    return typeof window.nostr !== 'undefined';
  }

  /**
   * Get available extension name
   */
  public getExtensionName(): string {
    if (!this.isExtensionAvailable()) {
      return 'none';
    }

    // Try to detect specific extensions based on user agent or other methods
    // This is a simple heuristic - extensions don't always expose their identity
    const userAgent = navigator.userAgent.toLowerCase();

    if (userAgent.includes('alby')) {
      return 'Alby';
    }

    // For now, return generic name if we can't detect specific extension
    return 'Browser Extension';
  }

  /**
   * Authenticate with npub (read-only mode)
   */
  public async authenticateWithNpub(npub: string): Promise<{ success: boolean; npub?: string; pubkey?: string; error?: string; readOnly?: boolean }> {
    try {
      // Validate npub format
      if (!npub.startsWith('npub1')) {
        return {
          success: false,
          error: 'Invalid npub format. Must start with npub1'
        };
      }

      // Decode npub to hex pubkey
      const decoded = decodeNip19(npub);
      if (decoded.type !== 'npub') {
        return {
          success: false,
          error: 'Invalid npub key format'
        };
      }
      const pubkey = decoded.data as string;

      // Set read-only mode (no signing capability)
      this.currentUser = { npub, pubkey };
      this.authMethod = 'npub';
      this.isReadOnly = true;
      this.saveSession();

      // Emit login event for NIP-65 relay list fetching
      this.eventBus.emit('user:login', { npub, pubkey });

      return {
        success: true,
        npub,
        pubkey,
        readOnly: true
      };
    } catch (error) {
      console.error('npub authentication failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Invalid npub key'
      };
    }
  }

  /**
   * Authenticate with direct nsec input
   */
  public async authenticateWithNsec(nsec: string): Promise<{ success: boolean; npub?: string; pubkey?: string; error?: string }> {
    try {
      // Validate nsec format (should start with 'nsec1')
      if (!nsec.startsWith('nsec1')) {
        return {
          success: false,
          error: 'Invalid nsec format. Must start with nsec1'
        };
      }

      // Convert nsec to hex private key
      const decoded = decodeNip19(nsec);
      if (decoded.type !== 'nsec') {
        return {
          success: false,
          error: 'Invalid nsec key format'
        };
      }
      const privateKey = decoded.data as string;

      // Derive public key from private key
      const pubkey = getPublicKeyFromPrivate(privateKey);
      const npub = hexToNpub(pubkey);

      // Store nsec in Keychain (or localStorage fallback)
      await KeychainStorage.saveNsec(nsec);

      // Store in memory for signing
      this.nsec = nsec;
      this.currentUser = { npub, pubkey };
      this.authMethod = 'nsec';
      this.saveSession();

      // Emit login event for NIP-65 relay list fetching
      this.eventBus.emit('user:login', { npub, pubkey });

      return {
        success: true,
        npub,
        pubkey
      };
    } catch (error) {
      console.error('nsec authentication failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Invalid nsec key'
      };
    }
  }

  /**
   * Authenticate with NIP-46 bunker:// URI
   * Delegates to Nip46SignerManager
   */
  public async authenticateWithBunker(bunkerUri: string): Promise<{ success: boolean; npub?: string; pubkey?: string; error?: string }> {
    // Create manager if needed
    if (!this.nip46Manager) {
      this.nip46Manager = new Nip46SignerManager();
    }

    const result = await this.nip46Manager.authenticate(bunkerUri);

    if (result.success && result.npub && result.pubkey) {
      this.currentUser = { npub: result.npub, pubkey: result.pubkey };
      this.authMethod = 'nip46';
      this.saveSession();
      this.saveToAccountStorage(bunkerUri);

      // Emit login event for NIP-65 relay list fetching
      this.eventBus.emit('user:login', { npub: result.npub, pubkey: result.pubkey });

      // Log success and show toast
      const { SystemLogger } = await import('../components/system/SystemLogger');
      const { ToastService } = await import('./ToastService');
      SystemLogger.getInstance().info('Auth', 'Login with Remote Signer: successful');
      ToastService.show('Login with Remote Signer: successful', 'success');
    }

    return result;
  }

  /**
   * Restore NIP-46 session from stored payload
   * Delegates to Nip46SignerManager
   */
  private async restoreNip46Session(): Promise<boolean> {
    // Create manager if needed
    if (!this.nip46Manager) {
      this.nip46Manager = new Nip46SignerManager();
    }

    return await this.nip46Manager.restoreSession();
  }


  /**
   * Try auto-login with KeySigner if daemon is already running
   * This is the PRIMARY login mechanism for key-signer (no localStorage)
   */
  private async tryAutoLoginWithKeySigner(): Promise<void> {
    // Only try if no current session
    if (this.currentUser) {
      return;
    }

    if (!this.keySignerManager) {
      return;
    }

    try {
      const result = await this.keySignerManager.tryAutoLogin();

      if (result.success && result.npub && result.pubkey) {
        this.currentUser = { npub: result.npub, pubkey: result.pubkey };
        this.authMethod = 'key-signer';
        // NO saveSession() - daemon is single source of truth
        this.saveToAccountStorage();

        this.eventBus.emit('user:login', { npub: result.npub, pubkey: result.pubkey });
      }
    } catch (_error) {
      // Silent fail - user can manually login
    }
  }

  /**
   * Cancel KeySigner login (delegate to manager)
   */
  public async cancelKeySignerLogin(): Promise<void> {
    if (this.keySignerManager) {
      await this.keySignerManager.cancelLogin();
    }
  }

  /**
   * Authenticate with KeySigner daemon
   * NO localStorage session - daemon is single source of truth
   */
  public async authenticateWithKeySigner(): Promise<{ success: boolean; npub?: string; pubkey?: string; error?: string }> {
    if (!this.keySignerManager) {
      return {
        success: false,
        error: 'KeySigner is only available in Tauri desktop app'
      };
    }

    try {
      const result = await this.keySignerManager.authenticate();

      if (result.success && result.npub && result.pubkey) {
        this.currentUser = { npub: result.npub, pubkey: result.pubkey };
        this.authMethod = 'key-signer';
        // NO saveSession() - daemon is single source of truth
        this.saveToAccountStorage();

        // Emit login event for NIP-65 relay list fetching
        this.eventBus.emit('user:login', { npub: result.npub, pubkey: result.pubkey });

        return {
          success: true,
          npub: result.npub,
          pubkey: result.pubkey
        };
      }

      return result;
    } catch (error) {
      console.error('[AuthService] KeySigner authentication failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'KeySigner authentication failed'
      };
    }
  }

  /**
   * Attempt to authenticate with browser extension (NIP-07)
   */
  public async authenticate(): Promise<{ success: boolean; npub?: string; pubkey?: string; error?: string }> {
    if (!this.isExtensionAvailable()) {
      return {
        success: false,
        error: 'No Nostr extension found. Please install Alby, nos2x, or another Nostr browser extension.'
      };
    }

    try {
      this.extension = window.nostr!;

      // Get public key from extension
      // ***alby browser extention throws non accurate errors + errors behaviour is inconsistant accross mainstream browsers
      const pubkey = await this.extension.getPublicKey();

      if (!pubkey) {
        return {
          success: false,
          error: 'Failed to get public key from extension'
        };
      }

      // Convert hex pubkey to npub format
      const npub = hexToNpub(pubkey);

      if (!npub) throw Error(`${this.getExtensionName()} extension provided invalid invalid hex pubkey`)

      this.currentUser = { npub, pubkey };
      this.authMethod = 'extension';
      this.saveSession();
      this.saveToAccountStorage();

      // Emit login event for NIP-65 relay list fetching
      this.eventBus.emit('user:login', { npub, pubkey });

      return {
        success: true,
        npub,
        pubkey
      };
    } catch (error) {
      console.error('Authentication failed:', error);

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Authentication failed'
      };
    }
  }

  /**
   * Get current authenticated user
   */
  public getCurrentUser(): { npub: string; pubkey: string } | null {
    return this.currentUser;
  }

  /**
   * Check if current session is read-only (npub only, no signing)
   */
  public isReadOnlyMode(): boolean {
    return this.isReadOnly;
  }

  /**
   * Sign out current user
   * If using key-signer, ask user if daemon should also be stopped
   */
  public async signOut(): Promise<void> {
    let shouldStopDaemon = false;

    // If using key-signer, ask if daemon should be stopped
    if (this.authMethod === 'key-signer' && this.keySignerManager) {
      shouldStopDaemon = await this.askStopDaemon();
    }

    // Stop daemon polling and cleanup manager
    if (this.keySignerManager) {
      this.keySignerManager.stopDaemonPolling();
    }

    // Cleanup NIP-46 signer
    if (this.nip46Manager) {
      this.nip46Manager.cleanup();
      this.nip46Manager = null;
    }

    // Clear session first
    this.currentUser = null;
    this.extension = null;
    this.nsec = null;
    this.authMethod = null;
    this.isReadOnly = false;

    // Clear only auth credentials (nsec), NWC remains persistent
    await KeychainStorage.clearAuth();

    this.clearSession();

    // Emit logout event to reset relay list to defaults
    this.eventBus.emit('user:logout');

    // AFTER logout: stop daemon if requested
    if (shouldStopDaemon && this.keySignerManager) {
      const keySigner = this.keySignerManager.getClient();
      if (keySigner) {
        try {
          await keySigner.stopDaemon();
          console.log('[AuthService] NoorSigner daemon stopped');

          // Show success toast in login view
          const { ToastService } = await import('./ToastService');
          ToastService.show('Key signer stopped', 'success');
        } catch (error) {
          console.warn('[AuthService] Failed to stop daemon:', error);

          // Show error toast
          const { ToastService } = await import('./ToastService');
          ToastService.show('Failed to stop key signer', 'error');
        }
      }

      // Cleanup manager
      this.keySignerManager.clear();
    }
  }

  /**
   * Ask user if daemon should be stopped (confirmation dialog)
   */
  private async askStopDaemon(): Promise<boolean> {
    const STORAGE_KEY = 'noornote_quit_key_signer_preference';
    const STORAGE_KEY_REMEMBER = 'noornote_quit_key_signer_remember';

    // Check if user wants to remember preference
    const remember = localStorage.getItem(STORAGE_KEY_REMEMBER) === 'true';
    if (remember) {
      const storedPreference = localStorage.getItem(STORAGE_KEY) === 'true';
      return storedPreference;
    }

    return new Promise(async (resolve) => {
      const { ModalService } = await import('./ModalService');
      const modalService = ModalService.getInstance();

      // Load last preference (default: false = keep running)
      const lastPreference = localStorage.getItem(STORAGE_KEY) === 'true';

      // Create dialog content
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

      // Get elements
      const quitSignerCheckbox = content.querySelector('#quit-signer-checkbox') as HTMLInputElement;
      const rememberCheckbox = content.querySelector('#remember-checkbox') as HTMLInputElement;
      const quitBtn = content.querySelector('[data-action="quit"]') as HTMLButtonElement;
      const cancelBtn = content.querySelector('[data-action="cancel"]') as HTMLButtonElement;

      // Update button text when checkbox changes
      const updateButtonText = () => {
        if (quitSignerCheckbox.checked) {
          quitBtn.textContent = 'Quit NoorNote & Key Signer';
        } else {
          quitBtn.textContent = 'Quit NoorNote';
        }
      };

      quitSignerCheckbox.addEventListener('change', updateButtonText);
      updateButtonText(); // Initial update

      // Quit button handler
      quitBtn.addEventListener('click', () => {
        const quitSigner = quitSignerCheckbox.checked;
        const remember = rememberCheckbox.checked;

        // Save preference
        localStorage.setItem(STORAGE_KEY, quitSigner.toString());

        if (remember) {
          localStorage.setItem(STORAGE_KEY_REMEMBER, 'true');
        } else {
          localStorage.removeItem(STORAGE_KEY_REMEMBER);
        }

        modalService.hide();
        resolve(quitSigner);
      });

      // Cancel button handler
      cancelBtn.addEventListener('click', () => {
        modalService.hide();
        // Don't resolve - user cancelled logout
      });

      // Modal onClose handler (X, ESC, click-outside) - treat as cancel
      const onModalClose = () => {
        // Don't resolve - user cancelled logout
      };

      // Show modal (with close handlers enabled)
      modalService.show({
        title: 'Quit NoorNote & Key Signer?',
        content,
        width: '450px',
        height: 'auto',
        closeOnOverlay: true,
        closeOnEsc: true,
        showCloseButton: true,
        onClose: onModalClose
      });
    });
  }

  /**
   * Get extension instance for signing operations
   */
  public getExtension(): NostrExtension | null {
    return this.extension;
  }

  /**
   * Sign a Nostr event
   * Uses nsec (direct), browser extension, key signer, or NIP-46 bunker depending on auth method
   * Automatically adds 'client' tag to all events
   */
  public async signEvent(event: any): Promise<any> {
    // Block signing in read-only mode
    if (this.isReadOnly) {
      throw new Error('Cannot sign events in read-only mode (npub login). Please login with nsec for write access.');
    }

    // Add client tag to all events (unless already present)
    const hasClientTag = event.tags?.some((tag: string[]) => tag[0] === 'client');

    if (!hasClientTag) {
      if (!event.tags) {
        event.tags = [];
      }
      event.tags.push(['client', 'NoorNote']);
    }

    try {
      if (this.authMethod === 'nsec' && this.nsec) {
        // Direct nsec signing using nostr-tools
        const decoded = decodeNip19(this.nsec);
        if (decoded.type !== 'nsec') {
          throw new Error('Invalid nsec key in session');
        }
        const privateKey = decoded.data as string;

        // Use adapter to finalize event signing
        return finalizeEventSigning(event, privateKey, this.currentUser!.pubkey);
      } else if (this.authMethod === 'extension' && this.extension) {
        // Browser extension signing
        const signedEvent = await this.extension.signEvent(event);
        return signedEvent;
      } else if (this.authMethod === 'key-signer' && this.keySignerManager) {
        const keySigner = this.keySignerManager.getClient();
        if (!keySigner) {
          throw new Error('KeySigner client not available');
        }

        // Build complete event BEFORE signing (KeySigner needs pubkey+id to calculate correct hash)
        event.pubkey = this.currentUser!.pubkey;
        event.id = calculateEventHash(event as UnsignedEvent);

        // KeySigner daemon signing - returns only signature
        const signature = await keySigner.signEvent(event);
        event.sig = signature;

        // Verify the signature matches the event
        const { verifyEventSignature } = await import('./NostrToolsAdapter');
        const isValid = verifyEventSignature(event as NostrEvent);

        if (!isValid) {
          throw new Error('KeySigner returned invalid signature - hash mismatch');
        }

        return event;
      } else if (this.authMethod === 'nip46' && this.nip46Manager?.isAvailable()) {
        // NIP-46 remote signer
        // Set pubkey before signing
        event.pubkey = this.currentUser!.pubkey;

        // Sign via manager - returns signature string
        const signature = await this.nip46Manager.signEvent(event);

        // Calculate event hash
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

  /**
   * NIP-44 encrypt plaintext for a recipient
   * Uses nsec, browser extension, key signer, or NIP-46 bunker depending on auth method
   */
  public async nip44Encrypt(plaintext: string, recipientPubkey: string): Promise<string> {
    if (this.isReadOnly) {
      throw new Error('Cannot encrypt in read-only mode (npub login)');
    }

    try {
      if (this.authMethod === 'nsec' && this.nsec) {
        // Use nostr-tools for direct encryption
        const { nip44Encrypt } = await import('./NostrToolsAdapter');
        return nip44Encrypt(plaintext, recipientPubkey, this.nsec);
      } else if (this.authMethod === 'extension' && this.extension?.nip44) {
        return await this.extension.nip44.encrypt(recipientPubkey, plaintext);
      } else if (this.authMethod === 'key-signer' && this.keySignerManager) {
        const keySigner = this.keySignerManager.getClient();
        if (!keySigner) {
          throw new Error('KeySigner client not available');
        }
        return await keySigner.nip44Encrypt(plaintext, recipientPubkey);
      } else if (this.authMethod === 'nip46' && this.nip46Manager) {
        return await this.nip46Manager.nip44Encrypt(plaintext, recipientPubkey);
      } else {
        throw new Error('No encryption method available');
      }
    } catch (error) {
      console.error('NIP-44 encryption error:', error);
      throw error;
    }
  }

  /**
   * NIP-44 decrypt ciphertext from a sender
   * Uses nsec, browser extension, key signer, or NIP-46 bunker depending on auth method
   */
  public async nip44Decrypt(ciphertext: string, senderPubkey: string): Promise<string> {
    if (this.isReadOnly) {
      throw new Error('Cannot decrypt in read-only mode (npub login)');
    }

    try {
      if (this.authMethod === 'nsec' && this.nsec) {
        // Use nostr-tools for direct decryption
        const { nip44Decrypt } = await import('./NostrToolsAdapter');
        return nip44Decrypt(ciphertext, senderPubkey, this.nsec);
      } else if (this.authMethod === 'extension' && this.extension?.nip44) {
        return await this.extension.nip44.decrypt(senderPubkey, ciphertext);
      } else if (this.authMethod === 'key-signer' && this.keySignerManager) {
        const keySigner = this.keySignerManager.getClient();
        if (!keySigner) {
          throw new Error('KeySigner client not available');
        }
        return await keySigner.nip44Decrypt(ciphertext, senderPubkey);
      } else if (this.authMethod === 'nip46' && this.nip46Manager) {
        return await this.nip46Manager.nip44Decrypt(ciphertext, senderPubkey);
      } else {
        throw new Error('No decryption method available');
      }
    } catch (error) {
      console.error('NIP-44 decryption error:', error);
      throw error;
    }
  }

  /**
   * NIP-04 encrypt plaintext for a recipient (legacy)
   * Uses nsec, browser extension, key signer, or NIP-46 bunker depending on auth method
   */
  public async nip04Encrypt(plaintext: string, recipientPubkey: string): Promise<string> {
    if (this.isReadOnly) {
      throw new Error('Cannot encrypt in read-only mode (npub login)');
    }

    try {
      if (this.authMethod === 'nsec' && this.nsec) {
        const { nip04 } = await import('./NostrToolsAdapter');
        return await nip04.encrypt(this.nsec, recipientPubkey, plaintext);
      } else if (this.authMethod === 'extension' && this.extension?.nip04) {
        return await this.extension.nip04.encrypt(recipientPubkey, plaintext);
      } else if (this.authMethod === 'key-signer' && this.keySignerManager) {
        const keySigner = this.keySignerManager.getClient();
        if (!keySigner) {
          throw new Error('KeySigner client not available');
        }
        return await keySigner.nip04Encrypt(plaintext, recipientPubkey);
      } else if (this.authMethod === 'nip46' && this.nip46Manager) {
        return await this.nip46Manager.nip04Encrypt(plaintext, recipientPubkey);
      } else {
        throw new Error('No encryption method available');
      }
    } catch (error) {
      console.error('NIP-04 encryption error:', error);
      throw error;
    }
  }

  /**
   * NIP-04 decrypt ciphertext from a sender (legacy)
   * Uses nsec, browser extension, key signer, or NIP-46 bunker depending on auth method
   */
  public async nip04Decrypt(ciphertext: string, senderPubkey: string): Promise<string> {
    if (this.isReadOnly) {
      throw new Error('Cannot decrypt in read-only mode (npub login)');
    }

    try {
      if (this.authMethod === 'nsec' && this.nsec) {
        const { nip04 } = await import('./NostrToolsAdapter');
        return await nip04.decrypt(this.nsec, senderPubkey, ciphertext);
      } else if (this.authMethod === 'extension' && this.extension?.nip04) {
        return await this.extension.nip04.decrypt(senderPubkey, ciphertext);
      } else if (this.authMethod === 'key-signer' && this.keySignerManager) {
        const keySigner = this.keySignerManager.getClient();
        if (!keySigner) {
          throw new Error('KeySigner client not available');
        }
        return await keySigner.nip04Decrypt(ciphertext, senderPubkey);
      } else if (this.authMethod === 'nip46' && this.nip46Manager) {
        return await this.nip46Manager.nip04Decrypt(ciphertext, senderPubkey);
      } else {
        throw new Error('No decryption method available');
      }
    } catch (error) {
      console.error('NIP-04 decryption error:', error);
      throw error;
    }
  }

  /**
   * Check if user has a valid session
   */
  public hasValidSession(): boolean {
    return this.currentUser !== null;
  }

  /**
   * Restore extension connection for existing session
   */
  public async restoreExtensionConnection(): Promise<boolean> {
    if (!this.currentUser || !this.isExtensionAvailable()) {
      return false;
    }

    try {
      this.extension = window.nostr!;

      // Verify the extension still has the same public key
      const currentPubkey = await this.extension.getPublicKey();

      if (currentPubkey === this.currentUser.pubkey) {
        return true;
      } else {
        // Public key mismatch - clear session
        this.clearSession();
        return false;
      }
    } catch (error) {
      console.warn('Failed to restore extension connection:', error);
      this.clearSession();
      return false;
    }
  }

  /**
   * Load session from localStorage
   * NOTE: key-signer sessions are IGNORED - daemon is single source of truth
   */
  private async loadSession(): Promise<void> {
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (stored) {
        const sessionData = JSON.parse(stored);
        if (sessionData.npub && sessionData.pubkey && sessionData.timestamp && sessionData.authMethod) {
          // IGNORE key-signer sessions - daemon is single source of truth
          if (sessionData.authMethod === 'key-signer') {
            localStorage.removeItem(this.storageKey);
            return;
          }

          // Check if session is not too old (7 days for Tauri, web: 24h)
          const sessionAge = Date.now() - sessionData.timestamp;
          const maxAge = 7 * 24 * 60 * 60 * 1000; // Tauri: 7 days (web: 24h)

          if (sessionAge < maxAge) {
            this.currentUser = {
              npub: sessionData.npub,
              pubkey: sessionData.pubkey
            };
            this.authMethod = sessionData.authMethod;
            this.isReadOnly = sessionData.isReadOnly || false;

            // Restore auth method specific state (await for proper initialization)
            if (this.authMethod === 'nsec') {
              await this.restoreNsecFromKeychain();
            }

            if (this.authMethod === 'nip46') {
              await this.restoreNip46Session();
            }

            // Emit user:login event AFTER restores complete
            // This triggers NIP-65 relay loading
            this.eventBus.emit('user:login', { npub: sessionData.npub, pubkey: sessionData.pubkey });
          } else {
            // Session expired
            this.clearSession();
          }
        }
      }
    } catch (error) {
      console.warn('Failed to load session:', error);
      this.clearSession();
    }
  }

  /**
   * Restore nsec from Keychain after session load
   */
  private async restoreNsecFromKeychain(): Promise<void> {
    try {
      const nsec = await KeychainStorage.loadNsec();
      if (nsec) {
        this.nsec = nsec;
      } else {
        // nsec not found in Keychain - clear session
        this.clearSession();
      }
    } catch (error) {
      console.warn('Failed to restore nsec from Keychain:', error);
      this.clearSession();
    }
  }

  /**
   * Save session to localStorage
   * NOTE: key-signer sessions are NEVER saved - daemon is single source of truth
   */
  private saveSession(): void {
    if (!this.currentUser || !this.authMethod) return;

    // NEVER save key-signer sessions to localStorage
    if (this.authMethod === 'key-signer') {
      return;
    }

    try {
      const sessionData = {
        npub: this.currentUser.npub,
        pubkey: this.currentUser.pubkey,
        authMethod: this.authMethod,
        isReadOnly: this.isReadOnly,
        timestamp: Date.now()
      };
      localStorage.setItem(this.storageKey, JSON.stringify(sessionData));
    } catch (error) {
      console.warn('Failed to save session:', error);
    }
  }

  /**
   * Clear session from localStorage
   */
  private clearSession(): void {
    try {
      localStorage.removeItem(this.storageKey);
    } catch (error) {
      console.warn('Failed to clear session:', error);
    }
    this.currentUser = null;
    this.extension = null;
    this.nsec = null;
    if (this.nip46Manager) {
      this.nip46Manager.cleanup();
      this.nip46Manager = null;
    }
    this.authMethod = null;
    this.isReadOnly = false;
  }

  /**
   * Get current auth method
   */
  public getAuthMethod(): AuthMethod | null {
    return this.authMethod;
  }

  // ==========================================
  // Multi-Account Support Methods
  // ==========================================

  /**
   * Get all stored accounts
   */
  public getStoredAccounts(): StoredAccount[] {
    return this.accountStorage.getAccounts();
  }

  /**
   * Switch to a stored account
   */
  public async switchAccount(pubkey: string): Promise<{ success: boolean; error?: string }> {
    const account = this.accountStorage.getAccount(pubkey);
    if (!account) {
      return { success: false, error: 'Account not found' };
    }

    // First sign out current user (without stopping daemon for key-signer)
    await this.signOutWithoutDaemonStop();

    // Now authenticate with the stored account
    switch (account.authMethod) {
      case 'extension':
        const extResult = await this.authenticate();
        if (extResult.success) {
          this.accountStorage.touchAccount(pubkey);
        }
        return extResult;

      case 'nip46':
        if (account.bunkerUri) {
          const bunkerResult = await this.authenticateWithBunker(account.bunkerUri);
          if (bunkerResult.success) {
            this.accountStorage.touchAccount(pubkey);
          }
          return bunkerResult;
        }
        return { success: false, error: 'No bunker URI stored for this account' };

      case 'key-signer':
        const keySignerResult = await this.authenticateWithKeySigner();
        if (keySignerResult.success) {
          this.accountStorage.touchAccount(pubkey);
        }
        return keySignerResult;

      default:
        return { success: false, error: `Unsupported auth method: ${account.authMethod}` };
    }
  }

  /**
   * Sign out without stopping daemon (for account switching)
   */
  private async signOutWithoutDaemonStop(): Promise<void> {
    // Stop daemon polling but don't stop daemon itself
    if (this.keySignerManager) {
      this.keySignerManager.stopDaemonPolling();
    }

    // Cleanup NIP-46 signer
    if (this.nip46Manager) {
      this.nip46Manager.cleanup();
      this.nip46Manager = null;
    }

    // Clear session
    this.currentUser = null;
    this.extension = null;
    this.nsec = null;
    this.authMethod = null;
    this.isReadOnly = false;

    // Clear auth credentials
    await KeychainStorage.clearAuth();
    this.clearSession();

    // Emit logout event
    this.eventBus.emit('user:logout');
  }

  /**
   * Remove a stored account
   */
  public async removeStoredAccount(pubkey: string): Promise<void> {
    // If removing current account, sign out first
    if (this.currentUser?.pubkey === pubkey) {
      await this.signOut();
    }

    // Remove from account storage
    this.accountStorage.removeAccount(pubkey);
  }

  /**
   * Sign out all accounts and clear storage
   */
  public async signOutAll(): Promise<void> {
    // Sign out current user
    await this.signOut();

    // Clear all stored accounts
    this.accountStorage.clearAll();
  }

  /**
   * Save current session to account storage
   * Called after successful authentication
   */
  private saveToAccountStorage(bunkerUri?: string): void {
    if (!this.currentUser || !this.authMethod) return;

    const account: StoredAccount = {
      pubkey: this.currentUser.pubkey,
      npub: this.currentUser.npub,
      authMethod: this.authMethod,
      addedAt: Date.now(),
      lastUsedAt: Date.now()
    };

    // Add bunkerUri for NIP-46
    if (bunkerUri) {
      account.bunkerUri = bunkerUri;
    }

    this.accountStorage.addAccount(account);
  }
}
