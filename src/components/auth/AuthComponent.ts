/**
 * Authentication Component
 * Handles login/logout UI and authentication flow
 * Supports: NoorSigner (local daemon) and Bunker (remote signer)
 */

import { AuthService } from '../../services/AuthService';
import { SystemLogger } from '../system/SystemLogger';
import { Router } from '../../services/Router';

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
    const primaryContent = document.querySelector('.primary-content');
    if (!primaryContent) return;

    // Check if adding account (from AccountSwitcher)
    const isAddingAccount = sessionStorage.getItem('noornote_add_account') === 'true';
    const pageTitle = isAddingAccount ? 'Add Account' : 'Welcome to NoorNote';

    primaryContent.innerHTML = `
      <div class="auth-login-card">
        <h1>${pageTitle}</h1>

        <section class="auth-section auth-section--primary">
          <div class="auth-primary-action">
            <button class="btn btn--large" data-action="use-key-signer">
              🔑 Use NoorSigner
            </button>
            <p class="auth-hint">Secure local key signer</p>
          </div>
          <div class="auth-primary-action ${this.authService.isExtensionAvailable() === false && 'hidden'}">
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
          <p class="auth-hint">Hardware signer or nsecBunker</p>
        </section>
      </div>
    `;

    // Setup event listeners for injected UI
    this.setupLoginViewListeners();
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
  }

  /**
   * Handle NoorSigner login
   */
  private async handleKeySignerLogin(): Promise<void> {
    const primaryContent = document.querySelector('.primary-content');
    const keySignerBtn = primaryContent?.querySelector('[data-action="use-key-signer"]') as HTMLButtonElement;

    if (!keySignerBtn) return;

    keySignerBtn.disabled = true;
    keySignerBtn.textContent = 'Launching daemon...';

    // Add cancel button
    const authSection = keySignerBtn.closest('.auth-section');
    let cancelBtn: HTMLButtonElement | null = null;

    if (authSection) {
      cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn--passive';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.style.marginTop = '0.5rem';
      cancelBtn.setAttribute('data-action', 'cancel-keysigner');
      authSection.querySelector('.auth-primary-action')?.appendChild(cancelBtn);
    }

    // Flag to track if user cancelled
    let userCancelled = false;

    // Cancel button handler
    const handleCancel = async () => {
      userCancelled = true;
      await this.authService.cancelKeySignerLogin();
      keySignerBtn.disabled = false;
      keySignerBtn.textContent = '🔑 Use NoorSigner';
      cancelBtn?.remove();
    };

    if (cancelBtn) {
      cancelBtn.addEventListener('click', handleCancel);
    }

    try {
      // Show waiting message
      setTimeout(() => {
        if (keySignerBtn.textContent === 'Launching daemon...' && !userCancelled) {
          keySignerBtn.textContent = '⏳ Waiting for password...';
        }
      }, 2000);

      const result = await this.authService.authenticateWithKeySigner();

      // Remove cancel button after completion
      cancelBtn?.remove();

      if (userCancelled) {
        return;
      }

      if (result.success && result.npub && result.pubkey) {
        this.currentUser = { npub: result.npub, pubkey: result.pubkey };
        this.systemLogger.info('Auth', 'Logged in successfully via NoorSigner');

        if (this.mainLayout) {
          this.mainLayout.setUserStatus(result.npub, result.pubkey);
        }

        this.updateUI();
        this.clearAddAccountFlag();

        // Navigate to timeline
        this.router.navigate('/');
      } else {
        this.systemLogger.error('Auth', 'NoorSigner login failed');
        this.showError(result.error || 'NoorSigner authentication failed');
        keySignerBtn.disabled = false;
        keySignerBtn.textContent = '🔑 Use NoorSigner';
      }
    } catch (error) {
      console.error('NoorSigner login error:', error);
      this.showError('Unexpected error during NoorSigner authentication');
      keySignerBtn.disabled = false;
      keySignerBtn.textContent = '🔑 Use NoorSigner';
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

    browserExtBtn.disabled = true;
      browserExtBtn.textContent = 'Waiting Extension';


    try {
      const result = await this.authService.authenticate();
      if (result.success && result.npub && result.pubkey){
        this.currentUser = { npub: result.npub, pubkey: result.pubkey };
        this.systemLogger.info('Auth', `Logged in successfully via ${this.authService.getExtensionName()} ${this.authService.getAuthMethod()}`);
        
        if (this.mainLayout) this.mainLayout.setUserStatus(result.npub, result.pubkey);
        
      }
  
  
      this.updateUI();
      this.clearAddAccountFlag();
  
      // Navigate to timeline
      this.router.navigate('/');
    } catch (error) {
      console.error('Browser extension login error:', error);
      this.showError(`${this.authService.getExtensionName()} ${this.authService.getAuthMethod()} error`);
      browserExtBtn.disabled = false;
      browserExtBtn.textContent = '🔑 Use Browser extension (Desktop)';
    }
  }


  /**
   * Handle bunker:// login (NIP-46 remote signer)
   */
  private async handleBunkerLogin(): Promise<void> {
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

    bunkerBtn.disabled = true;
    bunkerBtn.textContent = 'Connecting...';

    try {
      const result = await this.authService.authenticateWithBunker(bunkerUri);

      if (result.success && result.npub && result.pubkey) {
        this.currentUser = { npub: result.npub, pubkey: result.pubkey };
        this.systemLogger.info('Auth', 'Logged in successfully via bunker');

        if (this.mainLayout) {
          this.mainLayout.setUserStatus(result.npub, result.pubkey);
        }

        this.updateUI();
        this.clearAddAccountFlag();
        this.router.navigate('/');
      } else {
        this.systemLogger.error('Auth', 'Bunker login failed');
        this.showError(result.error || 'Bunker connection failed');
        bunkerBtn.disabled = false;
        bunkerBtn.textContent = 'Connect';
      }
    } catch (error) {
      console.error('Bunker login error:', error);
      this.showError('Unexpected error during bunker connection');
      bunkerBtn.disabled = false;
      bunkerBtn.textContent = 'Connect';
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
   * Show error message
   */
  private showError(message: string): void {
    const existingError = this.element.querySelector('.auth-error');
    if (existingError) {
      existingError.remove();
    }

    const errorElement = document.createElement('div');
    errorElement.className = 'auth-error';
    errorElement.innerHTML = `
      <p class="error">${message}</p>
    `;

    this.element.appendChild(errorElement);

    // Remove error after 5 seconds
    setTimeout(() => {
      if (errorElement.parentNode) {
        errorElement.remove();
      }
    }, 5000);
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
    this.element.remove();
  }
}
