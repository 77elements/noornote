/**
 * Account Storage Service
 * Manages multiple stored accounts for quick switching.
 *
 * Storage location: localStorage (noornote_accounts)
 *
 * This service is ADDITIVE - it does not replace or modify existing auth flow.
 * AuthService remains the single source of truth for current session.
 *
 * Key insight: No auth method requires nsec storage here. Keys are managed by:
 * - Browser Extension (browser manages)
 * - NoorSigner daemon (daemon manages)
 * - Remote signer (bunkerUri stored, no secrets)
 */

import type { AuthMethod } from './AuthService';

/**
 * Stored account metadata
 */
export interface StoredAccount {
  /** Hex public key - unique identifier */
  pubkey: string;
  /** Bech32 public key (npub1...) */
  npub: string;
  /** Authentication method used */
  authMethod: AuthMethod;
  /** Cached display name from profile (for offline display) */
  displayName?: string;
  /** Cached avatar URL from profile */
  avatarUrl?: string;
  /** Timestamp when account was added */
  addedAt: number;
  /** Timestamp of last successful login */
  lastUsedAt: number;
  /** For NIP-46: bunker URI (contains no secrets) */
  bunkerUri?: string;
}

/**
 * AccountStorageService
 *
 * Manages the list of stored accounts. Does NOT handle:
 * - Current session state (AuthService)
 * - Authentication flow (AuthService)
 */
export class AccountStorageService {
  private static instance: AccountStorageService;
  private readonly STORAGE_KEY = 'noornote_accounts';
  private readonly MIGRATION_KEY = 'noornote_accounts_migration_done';
  private readonly MAX_ACCOUNTS = 10;

  private constructor() {
    // Run migration on first instantiation
    this.migrateFromSingleAccount();
  }

  public static getInstance(): AccountStorageService {
    if (!AccountStorageService.instance) {
      AccountStorageService.instance = new AccountStorageService();
    }
    return AccountStorageService.instance;
  }

  /**
   * Get all stored accounts, sorted by lastUsedAt (most recent first)
   */
  public getAccounts(): StoredAccount[] {
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY);
      if (!stored) {
        return [];
      }

      const accounts: StoredAccount[] = JSON.parse(stored);

      // Sort by lastUsedAt descending (most recent first)
      return accounts.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    } catch (error) {
      console.error('[AccountStorageService] Failed to load accounts:', error);
      return [];
    }
  }

  /**
   * Get a specific account by pubkey
   */
  public getAccount(pubkey: string): StoredAccount | null {
    const accounts = this.getAccounts();
    return accounts.find(a => a.pubkey === pubkey) || null;
  }

  /**
   * Add a new account to storage
   * If account with same pubkey exists, updates it instead
   */
  public addAccount(account: StoredAccount): void {
    const accounts = this.getAccounts();

    // Check if account already exists
    const existingIndex = accounts.findIndex(a => a.pubkey === account.pubkey);

    if (existingIndex >= 0) {
      // Update existing account
      accounts[existingIndex] = {
        ...accounts[existingIndex],
        ...account,
        lastUsedAt: Date.now(),
      };
    } else {
      // Check max accounts limit
      if (accounts.length >= this.MAX_ACCOUNTS) {
        console.warn(
          `[AccountStorageService] Maximum accounts (${this.MAX_ACCOUNTS}) reached`
        );
        // Remove oldest account (by lastUsedAt)
        accounts.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
        accounts.shift();
      }

      // Add new account
      accounts.push({
        ...account,
        addedAt: account.addedAt || Date.now(),
        lastUsedAt: Date.now(),
      });
    }

    this.saveAccounts(accounts);
  }

  /**
   * Update an existing account's metadata
   */
  public updateAccount(pubkey: string, updates: Partial<StoredAccount>): void {
    const accounts = this.getAccounts();
    const index = accounts.findIndex(a => a.pubkey === pubkey);

    const existing = accounts[index];
    if (index >= 0 && existing) {
      accounts[index] = {
        pubkey: existing.pubkey,
        npub: existing.npub,
        authMethod: existing.authMethod,
        addedAt: existing.addedAt,
        lastUsedAt: existing.lastUsedAt,
        ...updates,
      };
      this.saveAccounts(accounts);
    }
  }

  /**
   * Update lastUsedAt timestamp for an account
   */
  public touchAccount(pubkey: string): void {
    this.updateAccount(pubkey, { lastUsedAt: Date.now() });
  }

  /**
   * Remove an account from storage
   */
  public removeAccount(pubkey: string): void {
    const accounts = this.getAccounts();
    const filtered = accounts.filter(a => a.pubkey !== pubkey);
    this.saveAccounts(filtered);
  }

  /**
   * Check if an account exists in storage
   */
  public hasAccount(pubkey: string): boolean {
    return this.getAccount(pubkey) !== null;
  }

  /**
   * Get number of stored accounts
   */
  public getAccountCount(): number {
    return this.getAccounts().length;
  }

  /**
   * Check if approaching max accounts limit
   */
  public isNearLimit(): boolean {
    return this.getAccountCount() >= this.MAX_ACCOUNTS - 2;
  }

  /**
   * Clear all stored accounts
   */
  public clearAll(): void {
    try {
      localStorage.removeItem(this.STORAGE_KEY);
    } catch (error) {
      console.error('[AccountStorageService] Failed to clear accounts:', error);
    }
  }

  /**
   * Save accounts to localStorage
   */
  private saveAccounts(accounts: StoredAccount[]): void {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(accounts));
    } catch (error) {
      console.error('[AccountStorageService] Failed to save accounts:', error);
    }
  }

  /**
   * Migrate from old single-account storage format
   * Runs once on first load after update
   */
  private migrateFromSingleAccount(): void {
    try {
      const migrationDone = localStorage.getItem(this.MIGRATION_KEY);
      if (migrationDone === 'true') return;

      const oldSession = localStorage.getItem('noornote_auth_session');
      if (!oldSession) {
        localStorage.setItem(this.MIGRATION_KEY, 'true');
        return;
      }

      const session = JSON.parse(oldSession);

      // Only migrate if we have valid session data
      if (session.pubkey && session.npub && session.authMethod) {
        // Check if already migrated (account already exists)
        if (!this.hasAccount(session.pubkey)) {
          this.addAccount({
            pubkey: session.pubkey,
            npub: session.npub,
            authMethod: session.authMethod,
            addedAt: Date.now(),
            lastUsedAt: Date.now(),
          });
          console.debug(
            '[AccountStorageService] Migrated existing account to multi-account storage'
          );
        }
      }

      localStorage.setItem(this.MIGRATION_KEY, 'true');
    } catch (error) {
      console.error('[AccountStorageService] Migration failed:', error);
      // Set migration done anyway to prevent repeated failures
      localStorage.setItem(this.MIGRATION_KEY, 'true');
    }
  }

  /**
   * Get auth method badge text for display
   */
  public static getAuthMethodBadge(authMethod: AuthMethod): string {
    switch (authMethod) {
      case 'extension':
        return 'Extension';
      case 'nip46':
        return 'Remote';
      case 'key-signer':
        return 'NoorSigner';
      default:
        return '';
    }
  }
}
