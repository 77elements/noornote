/**
 * Account Switcher Component
 * Shows current user with dropdown for switching between stored accounts.
 * Supports: NoorSigner (local daemon) and Bunker (remote signer)
 */

import { UserProfileService, UserProfile } from '../../services/UserProfileService';
import { AuthService } from '../../services/AuthService';
import { AccountStorageService } from '../../services/AccountStorageService';
import { KeySignerClient } from '../../services/KeySignerClient';
import { KeySignerPasswordModal } from '../modals/KeySignerPasswordModal';

export interface AccountSwitcherOptions {
  npub: string;
  pubkey: string;
  onLogout?: () => void;
  onAddAccount?: () => void;
}

interface DisplayAccount {
  pubkey: string;
  npub: string;
  displayName?: string;
  authMethod?: string;
}

export class AccountSwitcher {
  private element: HTMLElement;
  private dropdown: HTMLElement | null = null;
  private isOpen: boolean = false;
  private userProfileService: UserProfileService;
  private authService: AuthService;
  private accountStorage: AccountStorageService;
  private keySignerClient: KeySignerClient;
  private options: AccountSwitcherOptions;
  private profile: UserProfile | null = null;
  private unsubscribeProfile?: () => void;
  private clickOutsideHandler: (e: MouseEvent) => void;
  private profileCache: Map<string, UserProfile> = new Map();

  constructor(options: AccountSwitcherOptions) {
    this.userProfileService = UserProfileService.getInstance();
    this.authService = AuthService.getInstance();
    this.accountStorage = AccountStorageService.getInstance();
    this.keySignerClient = KeySignerClient.getInstance();
    this.options = options;
    this.element = this.createElement();
    this.loadProfile();

    // Click outside handler
    this.clickOutsideHandler = (e: MouseEvent) => {
      if (this.isOpen && !this.element.contains(e.target as Node)) {
        this.closeDropdown();
      }
    };
    document.addEventListener('click', this.clickOutsideHandler);
  }

  /**
   * Create account switcher element
   */
  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'account-switcher';
    container.innerHTML = `
      <button class="account-switcher__trigger" type="button">
        <div class="account-switcher__current">
          <span class="account-switcher__indicator"></span>
          <span class="account-switcher__name">Loading...</span>
        </div>
        <span class="account-switcher__arrow">&#9662;</span>
      </button>
    `;

    // Setup trigger click
    const trigger = container.querySelector('.account-switcher__trigger');
    if (trigger) {
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleDropdown();
      });
    }

    return container;
  }

  /**
   * Load user profile and update display
   */
  private async loadProfile(): Promise<void> {
    // Subscribe to profile updates
    this.unsubscribeProfile = this.userProfileService.subscribeToProfile(
      this.options.pubkey,
      (profile: UserProfile) => {
        this.profile = profile;
        this.profileCache.set(this.options.pubkey, profile);
        this.updateDisplay();

        // Also update account storage with profile info
        const displayName = profile.name || profile.display_name;
        const avatarUrl = profile.picture;
        this.accountStorage.updateAccount(this.options.pubkey, {
          ...(displayName && { displayName }),
          ...(avatarUrl && { avatarUrl })
        });
      }
    );

    // Trigger initial load
    try {
      await this.userProfileService.getUserProfile(this.options.pubkey);
    } catch (error) {
      console.warn(`[AccountSwitcher] Failed to load profile: ${this.options.pubkey}`, error);
      this.showFallback();
    }
  }

  /**
   * Update display with loaded profile
   */
  private updateDisplay(): void {
    const nameEl = this.element.querySelector('.account-switcher__name');
    if (nameEl) {
      const displayName = this.profile?.name || this.profile?.display_name || `${this.options.npub.slice(0, 12)}...`;
      nameEl.textContent = displayName;
    }
  }

  /**
   * Show fallback when profile loading fails
   */
  private showFallback(): void {
    const nameEl = this.element.querySelector('.account-switcher__name');
    if (nameEl) {
      nameEl.textContent = `${this.options.npub.slice(0, 12)}...`;
    }
  }

  /**
   * Toggle dropdown visibility
   */
  private toggleDropdown(): void {
    if (this.isOpen) {
      this.closeDropdown();
    } else {
      this.openDropdown();
    }
  }

  /**
   * Open dropdown
   */
  private async openDropdown(): Promise<void> {
    if (this.isOpen) return;

    this.isOpen = true;
    this.element.classList.add('account-switcher--open');

    // Show loading state
    this.dropdown = document.createElement('div');
    this.dropdown.className = 'account-switcher__dropdown';
    this.dropdown.innerHTML = '<div class="account-switcher__loading">Loading...</div>';
    this.element.appendChild(this.dropdown);

    // Fetch accounts and update dropdown
    await this.populateDropdown();
  }

  /**
   * Close dropdown
   */
  private closeDropdown(): void {
    if (!this.isOpen) return;

    this.isOpen = false;
    if (this.dropdown) {
      this.dropdown.remove();
      this.dropdown = null;
    }
    this.element.classList.remove('account-switcher--open');
  }

  /**
   * Populate dropdown with accounts
   */
  private async populateDropdown(): Promise<void> {
    if (!this.dropdown) return;

    const authMethod = this.authService.getAuthMethod();
    let accounts: DisplayAccount[] = [];

    // Fetch accounts based on auth method
    if (authMethod === 'key-signer') {
      // NoorSigner: get accounts from daemon
      try {
        const result = await this.keySignerClient.listAccounts();
        accounts = result.accounts.map(acc => ({
          pubkey: acc.pubkey,
          npub: acc.npub,
          authMethod: 'key-signer'
        }));

        // Load profiles for all accounts
        await this.loadAccountProfiles(accounts);
      } catch (error) {
        console.error('[AccountSwitcher] Failed to list NoorSigner accounts:', error);
      }
    } else if (authMethod === 'nip46') {
      // Bunker: get accounts from local storage
      const stored = this.accountStorage.getAccounts();
      accounts = stored
        .filter(acc => acc.authMethod === 'nip46')
        .map(acc => ({
          pubkey: acc.pubkey,
          npub: acc.npub,
          ...(acc.displayName && { displayName: acc.displayName }),
          authMethod: 'nip46'
        }));
    }

    // Build dropdown as simple ui-list
    this.dropdown.innerHTML = '';
    const currentPubkey = this.options.pubkey;

    // Header (only if multiple accounts)
    if (accounts.length > 1) {
      const header = document.createElement('div');
      header.className = 'account-switcher__header';
      header.textContent = 'Switch Account';
      this.dropdown.appendChild(header);
    }

    // Create list
    const list = document.createElement('ul');
    list.className = 'ui-list';

    // Account items (only if multiple accounts)
    if (accounts.length > 1) {
      for (const account of accounts) {
        const isActive = account.pubkey === currentPubkey;
        const item = this.createAccountItem(account, isActive);
        list.appendChild(item);
      }
    }

    // Add account
    const addItem = document.createElement('li');
    addItem.className = 'ui-list__item ui-list__item--clickable';
    addItem.innerHTML = '<span class="account-switcher__icon">+</span> Add account';
    addItem.addEventListener('click', () => this.handleAddAccount());
    list.appendChild(addItem);

    // Sign out
    const logoutItem = document.createElement('li');
    logoutItem.className = 'ui-list__item ui-list__item--clickable ui-list__item--danger';
    logoutItem.innerHTML = '<span class="account-switcher__icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg></span> Sign out';
    logoutItem.addEventListener('click', () => this.handleLogout());
    list.appendChild(logoutItem);

    this.dropdown.appendChild(list);
  }

  /**
   * Load profiles for accounts
   */
  private async loadAccountProfiles(accounts: DisplayAccount[]): Promise<void> {
    const promises = accounts.map(async (account) => {
      if (this.profileCache.has(account.pubkey)) {
        account.displayName = this.getDisplayName(this.profileCache.get(account.pubkey)!);
        return;
      }

      try {
        const profile = await this.userProfileService.getUserProfile(account.pubkey);
        if (profile) {
          this.profileCache.set(account.pubkey, profile);
          account.displayName = this.getDisplayName(profile);
        }
      } catch {
        // Profile load failed, use npub fallback
      }
    });

    await Promise.all(promises);
  }

  /**
   * Get display name from profile
   */
  private getDisplayName(profile: UserProfile): string {
    return profile.name || profile.display_name || '';
  }

  /**
   * Create account item element
   */
  private createAccountItem(account: DisplayAccount, isActive: boolean): HTMLElement {
    const item = document.createElement('li');
    item.className = `ui-list__item${isActive ? ' ui-list__item--active' : ' ui-list__item--clickable'}`;

    const displayName = account.displayName || `${account.npub.slice(0, 12)}...`;

    item.innerHTML = `
      <span class="account-switcher__account-name">${displayName}</span>
      ${isActive ? '<span class="account-switcher__active-dot"></span>' : ''}
    `;

    if (!isActive) {
      item.addEventListener('click', () => {
        if (account.authMethod === 'key-signer') {
          this.handleKeySignerSwitch(account);
        } else {
          this.handleBunkerSwitch(account);
        }
      });
    }

    return item;
  }

  /**
   * Handle NoorSigner account switch (requires password)
   */
  private handleKeySignerSwitch(account: DisplayAccount): void {
    this.closeDropdown();

    const modal = new KeySignerPasswordModal({
      npub: account.npub,
      ...(account.displayName && { displayName: account.displayName }),
      onSuccess: async () => {
        // NoorSigner has switched accounts - now re-authenticate to update AuthService
        await this.authService.authenticateWithKeySigner();
      }
    });

    modal.show();
  }

  /**
   * Handle Bunker account switch
   */
  private async handleBunkerSwitch(account: DisplayAccount): Promise<void> {
    this.closeDropdown();

    const result = await this.authService.switchAccount(account.pubkey);
    if (!result.success) {
      console.error('[AccountSwitcher] Bunker switch failed:', result.error);
    }
  }

  /**
   * Handle add account
   */
  private handleAddAccount(): void {
    this.closeDropdown();

    if (this.options.onAddAccount) {
      this.options.onAddAccount();
    }
  }

  /**
   * Handle logout current account
   */
  private handleLogout(): void {
    this.closeDropdown();

    if (this.options.onLogout) {
      this.options.onLogout();
    }
  }

  /**
   * Update user options (when switching accounts)
   */
  public updateUser(options: AccountSwitcherOptions): void {
    if (this.unsubscribeProfile) {
      this.unsubscribeProfile();
    }

    this.options = options;
    this.profile = null;
    this.loadProfile();
    this.closeDropdown();
  }

  /**
   * Get DOM element
   */
  public getElement(): HTMLElement {
    return this.element;
  }

  /**
   * Cleanup resources
   */
  public destroy(): void {
    if (this.unsubscribeProfile) {
      this.unsubscribeProfile();
    }
    document.removeEventListener('click', this.clickOutsideHandler);
    this.closeDropdown();
    this.element.remove();
  }
}
