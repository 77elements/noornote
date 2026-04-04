/**
 * Account Switcher Component
 * Shows current user with dropdown for switching between stored accounts.
 * Supports: NoorSigner (local daemon) and Bunker (remote signer)
 * Uses custom-dropdown CSS classes for consistent styling.
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
        this.close();
      }
    };
    document.addEventListener('click', this.clickOutsideHandler);
  }

  /**
   * Create account switcher element
   */
  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'custom-dropdown account-switcher';
    container.innerHTML = `
      <button class="custom-dropdown__trigger" type="button">
        <span class="account-switcher__indicator"></span>
        <span class="custom-dropdown__label">Loading...</span>
        <span class="custom-dropdown__arrow" aria-hidden="true"></span>
      </button>
    `;

    // Setup trigger click
    const trigger = container.querySelector('.custom-dropdown__trigger');
    if (trigger) {
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        this.isOpen ? this.close() : this.open();
      });
    }

    return container;
  }

  /**
   * Load user profile and update display
   */
  private async loadProfile(): Promise<void> {
    this.unsubscribeProfile = this.userProfileService.subscribeToProfile(
      this.options.pubkey,
      (profile: UserProfile) => {
        this.profile = profile;
        this.profileCache.set(this.options.pubkey, profile);
        this.updateDisplay();

        const displayName = profile.name || profile.display_name;
        const avatarUrl = profile.picture;
        this.accountStorage.updateAccount(this.options.pubkey, {
          ...(displayName && { displayName }),
          ...(avatarUrl && { avatarUrl })
        });
      }
    );

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
    const nameEl = this.element.querySelector('.custom-dropdown__label');
    if (nameEl) {
      const displayName = this.profile?.name || this.profile?.display_name || `${this.options.npub.slice(0, 12)}...`;
      nameEl.textContent = displayName;
    }
  }

  /**
   * Show fallback when profile loading fails
   */
  private showFallback(): void {
    const nameEl = this.element.querySelector('.custom-dropdown__label');
    if (nameEl) {
      nameEl.textContent = `${this.options.npub.slice(0, 12)}...`;
    }
  }

  /**
   * Open dropdown
   */
  private async open(): Promise<void> {
    if (this.isOpen) return;
    this.isOpen = true;
    this.element.classList.add('custom-dropdown--open');

    // Create menu
    const menu = document.createElement('ul');
    menu.className = 'custom-dropdown__menu';
    menu.style.display = 'block';
    menu.style.opacity = '1';
    menu.style.transform = 'translateY(0)';
    this.element.appendChild(menu);

    // Show loading
    menu.innerHTML = '<li class="custom-dropdown__item" style="opacity: 0.5;">Loading...</li>';

    await this.populateMenu(menu);
  }

  /**
   * Close dropdown
   */
  private close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.element.classList.remove('custom-dropdown--open');

    const menu = this.element.querySelector('.custom-dropdown__menu');
    if (menu) menu.remove();
  }

  /**
   * Populate menu with accounts
   */
  private async populateMenu(menu: HTMLElement): Promise<void> {
    const authMethod = this.authService.getAuthMethod();
    let accounts: DisplayAccount[] = [];

    if (authMethod === 'key-signer') {
      try {
        const result = await this.keySignerClient.listAccounts();
        accounts = result.accounts.map(acc => ({
          pubkey: acc.pubkey,
          npub: acc.npub,
          authMethod: 'key-signer'
        }));
        await this.loadAccountProfiles(accounts);
      } catch (error) {
        console.error('[AccountSwitcher] Failed to list NoorSigner accounts:', error);
      }
    } else if (authMethod === 'nip46') {
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

    menu.innerHTML = '';
    const currentPubkey = this.options.pubkey;

    // Account items (only if multiple accounts)
    if (accounts.length > 1) {
      for (const account of accounts) {
        const isActive = account.pubkey === currentPubkey;
        const displayName = account.displayName || `${account.npub.slice(0, 12)}...`;

        const item = document.createElement('li');
        item.className = `custom-dropdown__item${isActive ? ' custom-dropdown__item--selected' : ''}`;
        item.innerHTML = `${displayName}${isActive ? ' <span class="account-switcher__active-dot"></span>' : ''}`;

        if (!isActive) {
          item.addEventListener('click', () => {
            if (account.authMethod === 'key-signer') {
              this.handleKeySignerSwitch(account);
            } else {
              this.handleBunkerSwitch(account);
            }
          });
        }

        menu.appendChild(item);
      }
    }

    // Add account
    const addItem = document.createElement('li');
    addItem.className = 'custom-dropdown__item';
    addItem.innerHTML = '<span class="account-switcher__icon">+</span> Add account';
    addItem.addEventListener('click', () => this.handleAddAccount());
    menu.appendChild(addItem);

    // Sign out
    const logoutItem = document.createElement('li');
    logoutItem.className = 'custom-dropdown__item account-switcher__item--danger';
    logoutItem.innerHTML = '<span class="account-switcher__icon"><svg width="14" height="14"><use href="#icon-logout"/></svg></span> Sign out';
    logoutItem.addEventListener('click', () => this.handleLogout());
    menu.appendChild(logoutItem);
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
   * Handle NoorSigner account switch (requires password)
   */
  private handleKeySignerSwitch(account: DisplayAccount): void {
    this.close();
    const modal = new KeySignerPasswordModal({
      npub: account.npub,
      ...(account.displayName && { displayName: account.displayName }),
      onSuccess: async () => {
        await this.authService.authenticateWithKeySigner();
      }
    });
    modal.show();
  }

  /**
   * Handle Bunker account switch
   */
  private async handleBunkerSwitch(account: DisplayAccount): Promise<void> {
    this.close();
    const result = await this.authService.switchAccount(account.pubkey);
    if (!result.success) {
      console.error('[AccountSwitcher] Bunker switch failed:', result.error);
    }
  }

  /**
   * Handle add account
   */
  private handleAddAccount(): void {
    this.close();
    if (this.options.onAddAccount) {
      this.options.onAddAccount();
    }
  }

  /**
   * Handle logout current account
   */
  private handleLogout(): void {
    this.close();
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
    this.close();
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
    this.close();
    this.element.remove();
  }
}
