/**
 * Authentication Component
 * Handles login/logout UI and authentication flow
 * Supports: NoorSigner (local daemon), Bunker (remote signer), and NostrConnect QR
 */

import { AuthService } from '../../services/AuthService';
import { SystemLogger } from '../system/SystemLogger';
import { Router } from '../../services/Router';
import { PlatformService } from '../../services/PlatformService';
import QRCode from 'qrcode';

// Forward declaration to avoid circular dependency
interface MainLayoutInterface {
  setUserStatus(npub: string, pubkey: string): void;
  clearUserStatus(): void;
}

export class AuthComponent {
  private element: HTMLElement;
  private authService: AuthService;
  private systemLogger: SystemLogger;
  private router: Router;
  private mainLayout: MainLayoutInterface | null = null;
  private currentUser: { npub: string; pubkey: string } | null = null;
  private nostrConnectCancel: (() => void) | null = null;

  constructor(mainLayout?: MainLayoutInterface) {
    this.authService = AuthService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.router = Router.getInstance();
    this.mainLayout = mainLayout || null;

    // Check session BEFORE creating UI
    this.currentUser = this.authService.getCurrentUser();

    this.element = this.createElement();
    this.setupEventListeners();

    // Async session restore after UI is ready
    this.checkExistingSession();
  }

  /**
   * Create the authentication component UI
   */
  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'auth-component';

    if (this.currentUser) {
      // User is authenticated - show nothing (UserStatus shows username + logout)
      container.innerHTML = '';
    } else {
      // User not authenticated - show login button
      container.innerHTML = `
        <div class="user-status">
          <div class="user-info">
            <span class="user-indicator">○</span>
            <span class="user-display">Not logged in</span>
          </div>
          <button class="btn btn--mini" type="button" data-action="show-login">Login</button>
        </div>
      `;
    }

    return container;
  }

  /**
   * Setup event listeners for authentication actions
   */
  private setupEventListeners(): void {
    const showLoginBtn = this.element.querySelector('[data-action="show-login"]');
    if (showLoginBtn) {
      showLoginBtn.addEventListener('click', () => this.router.navigate('/login'));
    }
  }

  /**
   * Show login screen in primary-content
   * Two options: NoorSigner (primary) and Bunker (remote signer)
   */
  public showLoginScreen(): void {
    // Cancel any previous nostrconnect session
    this.cancelNostrConnect();

    const primaryContent = document.querySelector('.primary-content');
    if (!primaryContent) return;

    // Check platform for conditional rendering
    const platform = PlatformService.getInstance();

    // Check if adding account (from AccountSwitcher)
    const isAddingAccount = sessionStorage.getItem('noornote_add_account') === 'true';
    const pageTitle = isAddingAccount ? 'Add Account' : 'Welcome to NoorNote';

    primaryContent.innerHTML = `
      <div class="view-content view-content--login">
        <h1>${pageTitle}</h1>

        <section class="auth-section auth-section--primary">
          <div class="auth-primary-action ${!platform.isTauri ? 'hidden' : ''}">
            <button class="btn btn--large" data-action="use-key-signer">
              🔑 Use NoorSigner
            </button>
            <p class="auth-hint">Secure local key signer</p>
          </div>
          <div class="auth-primary-action ${platform.isTauri ? 'hidden' : ''}">
            <button class="btn btn--large" data-action="use-browser-ext-signer">
              🔑 Use Browser extension
            </button>
            <p class="auth-hint">Extension handles signing</p>
          </div>
        </section>

        <div class="auth-divider">
          <span>or</span>
        </div>

        <section class="auth-section">
          <h2>Remote Signer</h2>
          <div class="auth-nostrconnect" data-container="nostrconnect">
            <div class="auth-nostrconnect__qr" data-container="nostrconnect-qr">
              <div class="auth-nostrconnect__loading">Generating QR code...</div>
            </div>
            <p class="auth-hint">Scan with Amber or other mobile signer</p>
            <p class="auth-nostrconnect__status" data-status="nostrconnect">Waiting for connection...</p>
          </div>
          <div class="auth-divider auth-divider--small">
            <span>or enter bunker:// URI</span>
          </div>
          <div class="auth-input-group">
            <input
              type="text"
              class="input input--monospace"
              placeholder="bunker://..."
              data-input="bunker"
              autocomplete="off"
            />
            <button class="btn" data-action="connect-bunker">Connect</button>
          </div>
        </section>

        <div class="auth-divider">
          <span>or</span>
        </div>

        <p class="auth-hint" style="text-align: center;">
          <a href="#" data-action="create-account">Create a new Nostr account</a>
        </p>

        <p class="auth-hint ${!platform.isTauri ? 'hidden' : ''}" style="text-align: center;">
          <a href="#" data-action="import-to-noorsigner">Import existing key to NoorSigner</a>
        </p>
      </div>
    `;

    // Setup event listeners for injected UI
    this.setupLoginViewListeners();

    // Start nostrconnect QR flow
    this.initNostrConnect();
  }

  /**
   * Initialize nostrconnect:// QR code flow
   * Generates URI, renders QR, and waits for remote signer connection
   */
  private async initNostrConnect(): Promise<void> {
    const qrContainer = document.querySelector('[data-container="nostrconnect-qr"]');
    const statusEl = document.querySelector('[data-status="nostrconnect"]');
    if (!qrContainer) return;

    try {
      const session = await this.authService.startNostrConnect();
      this.nostrConnectCancel = session.cancel;

      // Render QR code
      const qrDataUrl = await QRCode.toDataURL(session.uri, {
        width: 200,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        }
      });

      qrContainer.innerHTML = `<img src="${qrDataUrl}" alt="Scan to connect" style="border-radius: 8px;" />`;

      // Wait for connection in background
      const result = await session.waitForConnection();

      if (result.success && result.npub && result.pubkey) {
        this.handleLoginSuccess(result.npub, result.pubkey, 'nostrconnect');
      } else if (result.error !== 'Cancelled') {
        if (statusEl) statusEl.textContent = 'Connection failed. Reload to try again.';
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.systemLogger.warn('Auth', `NostrConnect init failed: ${msg}`);
      qrContainer.innerHTML = '<p class="auth-hint">QR code unavailable</p>';
    }
  }

  /**
   * Cancel active nostrconnect session
   */
  private cancelNostrConnect(): void {
    if (this.nostrConnectCancel) {
      this.nostrConnectCancel();
      this.nostrConnectCancel = null;
    }
  }

  /**
   * Setup listeners for login view
   */
  private setupLoginViewListeners(): void {
    const primaryContent = document.querySelector('.primary-content');
    if (!primaryContent) return;

    // NoorSigner button
    const keySignerBtn = primaryContent.querySelector('[data-action="use-key-signer"]');
    if (keySignerBtn) {
      keySignerBtn.addEventListener('click', this.handleKeySignerLogin.bind(this));
    }

    // Browser Extension button
    const browserExtBtn = primaryContent.querySelector('[data-action="use-browser-ext-signer"]');
    if (browserExtBtn) {
      browserExtBtn.addEventListener('click', this.handleBrowserExtLogin.bind(this));
    }

    // Bunker connect button
    const bunkerBtn = primaryContent.querySelector('[data-action="connect-bunker"]');
    if (bunkerBtn) {
      bunkerBtn.addEventListener('click', this.handleBunkerLogin.bind(this));
    }

    // Enter key support for bunker input
    const bunkerInput = primaryContent.querySelector('[data-input="bunker"]');
    if (bunkerInput) {
      bunkerInput.addEventListener('keypress', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') {
          this.handleBunkerLogin();
        }
      });
    }

    // Create account link - clears localStorage and goes to welcome
    const createAccountLink = primaryContent.querySelector('[data-action="create-account"]');
    if (createAccountLink) {
      createAccountLink.addEventListener('click', (e) => {
        e.preventDefault();
        localStorage.removeItem('noornote_has_key');
        this.router.navigate('/welcome');
      });
    }

    // Import key to NoorSigner link
    const importLink = primaryContent.querySelector('[data-action="import-to-noorsigner"]');
    if (importLink) {
      importLink.addEventListener('click', (e) => {
        e.preventDefault();
        this.showImportModal();
      });
    }
  }

  /**
   * Handle successful login - common flow for all auth methods
   */
  private handleLoginSuccess(npub: string, pubkey: string, method: string): void {
    this.cancelNostrConnect();
    this.currentUser = { npub, pubkey };
    this.systemLogger.info('Auth', `Logged in successfully via ${method}`);

    if (this.mainLayout) {
      this.mainLayout.setUserStatus(npub, pubkey);
    }

    this.updateUI();
    this.clearAddAccountFlag();
    this.router.navigate('/');
  }

  /**
   * Reset button to original state
   */
  private resetButton(btn: HTMLButtonElement | null, text: string): void {
    if (btn) {
      btn.disabled = false;
      btn.textContent = text;
    }
  }

  /**
   * Show unlock modal when trust session expired (silent mode)
   */
  private showUnlockModal(): void {
    import('../modals/UnlockNoorSignerModal').then(({ UnlockNoorSignerModal }) => {
      const modal = new UnlockNoorSignerModal({
        onSuccess: async () => {
          const retryResult = await this.authService.authenticateWithKeySigner();
          if (retryResult.success && retryResult.npub && retryResult.pubkey) {
            this.handleLoginSuccess(retryResult.npub, retryResult.pubkey, 'NoorSigner');
          } else {
            this.showError(retryResult.error || 'Authentication failed after unlock');
          }
        }
      });
      modal.show();
    });
  }

  /**
   * Show import modal when no NoorSigner accounts exist (silent mode)
   */
  private showImportModal(): void {
    import('../modals/ImportToNoorSignerModal').then(({ ImportToNoorSignerModal }) => {
      const modal = new ImportToNoorSignerModal({
        nsec: '',
        npub: '',
        showNsecInput: true,
        onSuccess: async () => {
          const retryResult = await this.authService.authenticateWithKeySigner();
          if (retryResult.success && retryResult.npub && retryResult.pubkey) {
            this.handleLoginSuccess(retryResult.npub, retryResult.pubkey, 'NoorSigner');
          } else {
            this.showError(retryResult.error || 'Authentication failed after import');
          }
        }
      });
      modal.show();
    });
  }

  /**
   * Handle NoorSigner login
   */
  private async handleKeySignerLogin(): Promise<void> {
    const primaryContent = document.querySelector('.primary-content');
    const keySignerBtn = primaryContent?.querySelector('[data-action="use-key-signer"]') as HTMLButtonElement;
    if (!keySignerBtn) return;

    const originalText = '🔑 Use NoorSigner';
    keySignerBtn.disabled = true;
    keySignerBtn.textContent = 'Launching daemon...';

    // Add cancel button
    const authSection = keySignerBtn.closest('.auth-section');
    let cancelBtn: HTMLButtonElement | null = null;
    let userCancelled = false;

    if (authSection) {
      cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn--passive';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.style.marginTop = '0.5rem';
      cancelBtn.setAttribute('data-action', 'cancel-keysigner');
      authSection.querySelector('.auth-primary-action')?.appendChild(cancelBtn);

      cancelBtn.addEventListener('click', async () => {
        userCancelled = true;
        await this.authService.cancelKeySignerLogin();
        this.resetButton(keySignerBtn, originalText);
        cancelBtn?.remove();
      });
    }

    try {
      setTimeout(() => {
        if (keySignerBtn.textContent === 'Launching daemon...' && !userCancelled) {
          keySignerBtn.textContent = '⏳ Waiting for password...';
        }
      }, 2000);

      const result = await this.authService.authenticateWithKeySigner();
      cancelBtn?.remove();

      if (userCancelled) return;

      if (result.needsPassword) {
        this.resetButton(keySignerBtn, originalText);
        this.showUnlockModal();
        return;
      }

      if (result.needsImport) {
        this.resetButton(keySignerBtn, originalText);
        this.showImportModal();
        return;
      }

      if (result.success && result.npub && result.pubkey) {
        this.handleLoginSuccess(result.npub, result.pubkey, 'NoorSigner');
      } else {
        this.systemLogger.error('Auth', 'NoorSigner login failed');
        this.showError(result.error || 'NoorSigner authentication failed');
        this.resetButton(keySignerBtn, originalText);
      }
    } catch (error) {
      console.error('NoorSigner login error:', error);
      this.showError('Unexpected error during NoorSigner authentication');
      this.resetButton(keySignerBtn, originalText);
      cancelBtn?.remove();
    }
  }

  /**
   * Handle Browser Extension login (NIP-07)
   */
  private async handleBrowserExtLogin(): Promise<void> {
    const primaryContent = document.querySelector('.primary-content');
    const browserExtBtn = primaryContent?.querySelector('[data-action="use-browser-ext-signer"]') as HTMLButtonElement;
    if (!browserExtBtn) return;

    const originalText = '🔑 Use Browser extension';
    browserExtBtn.disabled = true;
    browserExtBtn.textContent = 'Waiting Extension';

    try {
      const result = await this.authService.authenticate();
      if (result.success && result.npub && result.pubkey) {
        const method = `${this.authService.getExtensionName()} ${this.authService.getAuthMethod()}`;
        this.handleLoginSuccess(result.npub, result.pubkey, method);
      }
    } catch (error) {
      console.error('Browser extension login error:', error);
      this.showError(`${this.authService.getExtensionName()} ${this.authService.getAuthMethod()} error`);
      this.resetButton(browserExtBtn, originalText);
    }
  }

  /**
   * Handle bunker:// login (NIP-46 remote signer)
   */
  private async handleBunkerLogin(): Promise<void> {
    // Cancel nostrconnect QR listener before using bunker:// input
    this.cancelNostrConnect();

    const primaryContent = document.querySelector('.primary-content');
    const bunkerInput = primaryContent?.querySelector('[data-input="bunker"]') as HTMLInputElement;
    const bunkerBtn = primaryContent?.querySelector('[data-action="connect-bunker"]') as HTMLButtonElement;
    if (!bunkerInput || !bunkerBtn) return;

    const bunkerUri = bunkerInput.value.trim();
    if (!bunkerUri) {
      this.showError('Please enter a bunker:// URI');
      return;
    }
    if (!bunkerUri.startsWith('bunker://')) {
      this.showError('Invalid bunker URI. Must start with bunker://');
      return;
    }

    const originalText = 'Connect';
    bunkerBtn.disabled = true;
    bunkerBtn.textContent = 'Connecting...';

    try {
      const result = await this.authService.authenticateWithBunker(bunkerUri);

      if (result.success && result.npub && result.pubkey) {
        this.handleLoginSuccess(result.npub, result.pubkey, 'bunker');
      } else {
        this.systemLogger.error('Auth', 'Bunker login failed');
        this.showError(result.error || 'Bunker connection failed');
        this.resetButton(bunkerBtn, originalText);
      }
    } catch (error) {
      console.error('Bunker login error:', error);
      this.showError('Unexpected error during bunker connection');
      this.resetButton(bunkerBtn, originalText);
    }
  }

  /**
   * Handle logout
   */
  public async handleLogout(): Promise<void> {
    await this.authService.signOut();
    this.currentUser = null;

    // Update own UI first (before MainLayout clears)
    this.updateUI();

    // Clear main layout user status (will re-mount this component)
    if (this.mainLayout) {
      this.mainLayout.clearUserStatus();
    }
  }

  /**
   * Clear add account flag after successful login
   */
  private clearAddAccountFlag(): void {
    sessionStorage.removeItem('noornote_add_account');
  }

  /**
   * Show error message (auto-removes after 5 seconds)
   */
  private showError(message: string): void {
    this.element.querySelector('.auth-error')?.remove();

    const errorElement = document.createElement('div');
    errorElement.className = 'auth-error';
    errorElement.innerHTML = `<p class="error">${message}</p>`;
    this.element.appendChild(errorElement);

    setTimeout(() => errorElement.remove(), 5000);
  }

  /**
   * Update the UI based on current authentication state
   */
  private updateUI(): void {
    const newElement = this.createElement();
    this.element.parentNode?.replaceChild(newElement, this.element);
    this.element = newElement;
    this.setupEventListeners();
  }

  /**
   * Get the DOM element
   */
  public getElement(): HTMLElement {
    return this.element;
  }

  /**
   * Check for existing session on component initialization
   */
  private async checkExistingSession(): Promise<void> {
    if (this.authService.hasValidSession()) {
      const currentUser = this.authService.getCurrentUser();
      if (currentUser) {
        this.systemLogger.info('Auth', 'Found existing session, attempting to restore');

        // Set user status immediately
        this.currentUser = currentUser;
        if (this.mainLayout) {
          this.mainLayout.setUserStatus(currentUser.npub, currentUser.pubkey);
        }

        // Try to restore signer connection
        const restored = await this.authService.restoreExtensionConnection();

        if (restored) {
          this.systemLogger.info('Auth', 'Signer connection restored');
        } else {
          this.systemLogger.info('Auth', 'Signer not available yet');
        }

        this.updateUI();

        // Reload current route to show Timeline
        this.router.navigate(window.location.pathname);
      }
    }
  }

  /**
   * Cleanup resources
   */
  public destroy(): void {
    this.cancelNostrConnect();
    this.element.remove();
  }
}
