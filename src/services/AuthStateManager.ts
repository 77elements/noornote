/**
 * Auth State Manager
 * Single source of truth for authentication state across the application
 * Provides reactive updates via subscribe pattern
 */

import { TypedEventBus } from '../core/TypedEventBus';
import { AuthService } from './AuthService';
import { UserProfileService } from './UserProfileService';

type AuthStateCallback = (isLoggedIn: boolean) => void;

export class AuthStateManager {
  private static instance: AuthStateManager;
  private isAuthenticated: boolean = false;
  private subscribers: Set<AuthStateCallback> = new Set();
  private eventBus: TypedEventBus;
  private authService: AuthService;
  private userProfileService: UserProfileService;

  private constructor() {
    this.eventBus = TypedEventBus.getInstance();
    this.authService = AuthService.getInstance();
    this.userProfileService = UserProfileService.getInstance();

    // Initialize auth state from AuthService
    this.isAuthenticated = this.authService.hasValidSession();

    // Set initial body class
    this.updateBodyClass();

    // Listen for auth state changes via TypedEventBus
    this.eventBus.on('user:login', (data: { npub: string; pubkey: string }) => {
      this.setAuthState(true);
      // Fetch and cache own profile on login (force refresh from relays)
      this.refreshOwnProfile(data.pubkey);
    });

    this.eventBus.on('user:logout', () => {
      this.setAuthState(false);
    });

    // If already logged in on init, refresh own profile
    if (this.isAuthenticated) {
      const currentUser = this.authService.getCurrentUser();
      if (currentUser) {
        this.refreshOwnProfile(currentUser.pubkey);
      }
    }
  }

  public static getInstance(): AuthStateManager {
    if (!AuthStateManager.instance) {
      AuthStateManager.instance = new AuthStateManager();
    }
    return AuthStateManager.instance;
  }

  /**
   * Check if user is currently logged in
   * Can be called from anywhere: Views, Components, Helpers
   */
  public isLoggedIn(): boolean {
    return this.isAuthenticated;
  }

  /**
   * Subscribe to auth state changes
   * Returns unsubscribe function for cleanup
   *
   * @example
   * const unsubscribe = authStateManager.subscribe((isLoggedIn) => {
   *   console.debug('Auth state changed:', isLoggedIn);
   * });
   * // Later: unsubscribe();
   */
  public subscribe(callback: AuthStateCallback): () => void {
    this.subscribers.add(callback);

    // Immediately call with current state
    callback(this.isAuthenticated);

    // Return unsubscribe function
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /**
   * Set auth state and notify all subscribers
   * Internal use only - state changes come from TypedEventBus
   */
  private setAuthState(isLoggedIn: boolean): void {
    if (this.isAuthenticated === isLoggedIn) {
      return; // No change
    }

    this.isAuthenticated = isLoggedIn;

    // Update body class
    this.updateBodyClass();

    // Notify all subscribers
    this.subscribers.forEach(callback => {
      callback(this.isAuthenticated);
    });
  }

  /**
   * Refresh own profile from relays and cache in IndexedDB
   * Called on login and session restore to ensure profile is up-to-date
   */
  private async refreshOwnProfile(pubkey: string): Promise<void> {
    try {
      // Fetch profile from relays (always fetches fresh, no cache)
      await this.userProfileService.getUserProfile(pubkey);
    } catch (error) {
      console.error('[AuthStateManager] Failed to refresh own profile:', error);
    }
  }

  /**
   * Update body class based on auth state
   */
  private updateBodyClass(): void {
    if (typeof document === 'undefined') return;

    const body = document.body;

    if (this.isAuthenticated) {
      body.classList.remove('logged-out');
      body.classList.add('logged-in');
    } else {
      body.classList.remove('logged-in');
      body.classList.add('logged-out');
    }
  }

  /**
   * Get number of active subscribers (for debugging)
   */
  public getSubscriberCount(): number {
    return this.subscribers.size;
  }
}

/**
 * Global function for browser console and application-wide access
 * Usage: isLoggedIn()
 */
export function isLoggedIn(): boolean {
  return AuthStateManager.getInstance().isLoggedIn();
}

// Expose to window for browser console access
declare global {
  interface Window {
    isLoggedIn: () => boolean;
  }
}

if (typeof window !== 'undefined') {
  window.isLoggedIn = isLoggedIn;
}
