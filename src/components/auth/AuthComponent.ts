/**
 * Authentication Component
 * Handles login/logout UI and authentication flow
 * Supports: NoorSigner (desktop), Amber (Android), Browser Extension (web),
 *           Bunker (remote signer), and NostrConnect QR (desktop/web)
 */

import { AuthService } from '../../services/AuthService';
import { SystemLogger } from '../system/SystemLogger';
import { Router } from '../../services/Router';
import { PlatformService } from '../../services/PlatformService';
import { LayoutService } from '../../services/LayoutService';
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
  /** Stored nostrconnect:// URI for the active session — used by the
   *  mobile-web "Open Amber" deep-link button so a tap can hand off to
   *  Amber via Android intent without scanning a QR code. */
  private nostrConnectUri: string | null = null;

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
   * Platform-aware: Desktop shows NoorSigner, Android shows Amber, Web shows Extension
   */
  public showLoginScreen(): void {
    // Cancel any previous nostrconnect session
    this.cancelNostrConnect();

    const primaryContent = document.querySelector('.primary-content');
    if (!primaryContent) return;

    const platform = PlatformService.getInstance();
    const isDesktop = platform.isDesktop;
    const isCapacitor = platform.isCapacitor;
    const isWeb = platform.isBrowser;
    // "Mobile layout" covers Capacitor APK, mobile-web (Android UA), AND a
    // desktop browser whose viewport sits below the phone breakpoint
    // (responsive devtools). The login UI then collapses the QR section
    // and offers a deep-link Amber button instead.
    const isMobileLayout = platform.isAndroid
      || LayoutService.getInstance().getCurrentMode() === 'phone';
    // Single Amber button — same label everywhere. Handler branches on
    // platform: Capacitor APK uses the NIP-55 plugin (direct intent),
    // mobile-web uses the nostrconnect:// deep-link (Amber registered as
    // URI handler on Android). Both end up logging in via the same relay
    // subscription that initNostrConnect sets up. Button starts disabled
    // on mobile-web until the URI is ready; Capacitor needs no URI so it
    // stays enabled from first paint.
    const showAmber = isCapacitor || isMobileLayout;
    const amberStartsDisabled = !isCapacitor && isMobileLayout;
    // Browser-extension login as a small inline link on mobile layout
    // (Alby is available on mobile Firefox) instead of a big primary
    // button, since Amber is the dominant signer story on a phone.
    const showBrowserExtBig = isWeb && !isMobileLayout;
    const showBrowserExtSmall = isWeb && isMobileLayout;

    // Check if adding account (from AccountSwitcher)
    const isAddingAccount = sessionStorage.getItem('noornote_add_account') === 'true';
    const pageTitle = isAddingAccount ? 'Add Account' : 'Welcome to NoorNote';

    primaryContent.innerHTML = `
      <div class="view-content view-content--login">
        <h1>${pageTitle}</h1>

        <section class="auth-section auth-section--primary">
          <div class="auth-primary-action ${!isDesktop ? 'hidden' : ''}">
            <button class="btn btn--large" data-action="use-key-signer">
              🔑 Use NoorSigner
            </button>
            <p class="auth-hint">Secure local key signer</p>
          </div>
          <div class="auth-primary-action ${!showAmber ? 'hidden' : ''}">
            <button class="btn btn--large" data-action="use-amber" ${amberStartsDisabled ? 'disabled' : ''}>
              🔑 Use Amber
            </button>
            <p class="auth-hint">NIP-55 Android signer</p>
          </div>
          <div class="auth-primary-action ${!showBrowserExtBig ? 'hidden' : ''}">
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
          <div class="auth-nostrconnect ${isMobileLayout ? 'hidden' : ''}" data-container="nostrconnect">
            <div class="auth-nostrconnect__qr" data-container="nostrconnect-qr">
              <div class="auth-nostrconnect__loading">Generating QR code...</div>
            </div>
            <p class="auth-hint">Scan with Amber or other mobile signer</p>
            <p class="auth-nostrconnect__status" data-status="nostrconnect">Waiting for connection...</p>
          </div>
          <p class="auth-nostrconnect__status ${!amberStartsDisabled ? 'hidden' : ''}" data-status="nostrconnect-mobile">Waiting for connection…</p>
          <div class="auth-divider auth-divider--small ${isMobileLayout ? 'hidden' : ''}">
            <span>${isMobileLayout ? '' : 'or '}enter bunker:// URI</span>
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

        <div class="auth-divider ${showBrowserExtSmall ? '' : 'hidden'}">
          <span>or</span>
        </div>
        <p class="auth-hint ${showBrowserExtSmall ? '' : 'hidden'}" style="text-align: center;">
          <a href="#" data-action="use-browser-ext-signer">Use Browser extension</a>
          (e.g. Alby on mobile Firefox)
        </p>

        <div class="auth-divider">
          <span>or</span>
        </div>

        <p class="auth-hint" style="text-align: center;">
          <a href="#" data-action="create-account">Create a new Nostr account</a>
        </p>

        <p class="auth-hint ${!isDesktop ? 'hidden' : ''}" style="text-align: center;">
          <a href="#" data-action="import-to-noorsigner">Import existing key to NoorSigner</a>
        </p>
      </div>
    `;

    // Setup event listeners for injected UI
    this.setupLoginViewListeners();

    // Start nostrconnect flow on every non-Capacitor platform — desktop
    // uses the QR, mobile-web uses the deep-link button. Capacitor APK
    // skips this since the Amber plugin path is synchronous.
    if (!isCapacitor) {
      this.initNostrConnect();
    }
  }

  /**
   * Initialize nostrconnect:// QR code flow
   * Generates URI, renders QR, and waits for remote signer connection
   */
  private async initNostrConnect(): Promise<void> {
    const qrContainer = document.querySelector('[data-container="nostrconnect-qr"]');
    const statusEl = document.querySelector('[data-status="nostrconnect"]');
    const statusElMobile = document.querySelector('[data-status="nostrconnect-mobile"]');
    // The mobile-web Amber button starts disabled (rendered as such)
    // because its click needs the nostrconnect URI. We enable it as soon
    // as the URI is in hand. Capacitor users never hit this branch — the
    // function is only invoked on `!isCapacitor`.
    const amberBtn = document.querySelector('[data-action="use-amber"]') as HTMLButtonElement | null;

    try {
      const session = await this.authService.startNostrConnect();
      this.nostrConnectCancel = session.cancel;
      this.nostrConnectUri = session.uri;

      // QR is desktop-only — the container is hidden on mobile layout.
      // Renders only if it actually exists in the DOM.
      if (qrContainer) {
        const qrDataUrl = await QRCode.toDataURL(session.uri, {
          width: 200,
          margin: 2,
          color: {
            dark: '#000000',
            light: '#FFFFFF'
          }
        });
        qrContainer.innerHTML = `<img src="${qrDataUrl}" alt="Scan to connect" style="border-radius: 8px; padding: 40px; background: #FFFFFF;" />`;
      }

      // Mobile-layout: enable the Amber button now that the URI is ready.
      if (amberBtn) amberBtn.disabled = false;

      // Wait for connection in background
      const result = await session.waitForConnection();

      if (result.success && result.npub && result.pubkey) {
        this.handleLoginSuccess(result.npub, result.pubkey, 'nostrconnect');
      } else if (result.error !== 'Cancelled') {
        if (statusEl) statusEl.textContent = 'Connection failed. Reload to try again.';
        if (statusElMobile) statusElMobile.textContent = 'Connection failed. Reload to try again.';
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.systemLogger.warn('Auth', `NostrConnect init failed: ${msg}`);
      if (qrContainer) qrContainer.innerHTML = '<p class="auth-hint">QR code unavailable</p>';
      if (statusElMobile) statusElMobile.textContent = 'Connection unavailable. Reload to try again.';
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

    // NoorSigner button (desktop)
    const keySignerBtn = primaryContent.querySelector('[data-action="use-key-signer"]');
    if (keySignerBtn) {
      keySignerBtn.addEventListener('click', this.handleKeySignerLogin.bind(this));
    }

    // Amber button (Capacitor APK — NIP-55 plugin path)
    const amberBtn = primaryContent.querySelector('[data-action="use-amber"]');
    if (amberBtn) {
      amberBtn.addEventListener('click', this.handleAmberLogin.bind(this));
    }

    // Browser Extension login — both the big primary-action button (desktop)
    // and the inline mobile-layout link (Alby on mobile Firefox) carry
    // this data-action, so a single querySelectorAll wires whichever
    // variant the current layout rendered.
    const browserExtTriggers = primaryContent.querySelectorAll('[data-action="use-browser-ext-signer"]');
    browserExtTriggers.forEach(el => {
      el.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).tagName === 'A') e.preventDefault();
        this.handleBrowserExtLogin();
      });
    });

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

    // Import key to NoorSigner link (desktop only)
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
   * Handle NoorSigner login (desktop)
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
   * Handle Amber login. Two paths under one button:
   *   - Capacitor APK: NIP-55 plugin → direct intent to Amber, returns
   *     pubkey synchronously.
   *   - Mobile-web: `window.location.href = nostrconnectUri` so Android
   *     hands the URI to the registered handler (Amber). The login then
   *     completes via the relay subscription opened by `initNostrConnect()`.
   */
  private async handleAmberLogin(): Promise<void> {
    const primaryContent = document.querySelector('.primary-content');
    const amberBtn = primaryContent?.querySelector('[data-action="use-amber"]') as HTMLButtonElement;
    if (!amberBtn) return;

    // Mobile-web branch — deep-link hand-off. No button reset; the page
    // is about to navigate away (intent) and login resolves in the
    // background via the nostrconnect subscription.
    if (!PlatformService.getInstance().isCapacitor) {
      if (!this.nostrConnectUri) {
        this.showError('Connection not ready yet — try again in a moment.');
        return;
      }
      const statusElMobile = document.querySelector('[data-status="nostrconnect-mobile"]');
      if (statusElMobile) statusElMobile.textContent = 'Opening Amber… approve there, then come back.';
      window.location.href = this.nostrConnectUri;
      return;
    }

    // Capacitor APK branch — synchronous plugin path.
    const originalText = '🔑 Use Amber';
    amberBtn.disabled = true;
    amberBtn.textContent = 'Opening Amber...';

    try {
      const result = await this.authService.authenticateWithAmber();

      if (result.success && result.npub && result.pubkey) {
        this.handleLoginSuccess(result.npub, result.pubkey, 'Amber');
      } else {
        this.showError(result.error || 'Amber authentication failed');
        this.resetButton(amberBtn, originalText);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`ERROR: ${msg}`);
      console.error('Amber login error:', msg);
      this.showError(`Amber error: ${msg}`);
      this.resetButton(amberBtn, originalText);
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
    // Show error in login view (where user is looking), fallback to component element
    const loginView = document.querySelector('.view-content--login');
    const container = loginView || this.element;

    container.querySelector('.auth-error')?.remove();

    const errorElement = document.createElement('div');
    errorElement.className = 'auth-error';
    errorElement.innerHTML = `<p class="error">${message}</p>`;
    container.appendChild(errorElement);

    setTimeout(() => errorElement.remove(), 8000);
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
