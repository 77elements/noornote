/**
 * Central State Manager (Singleton)
 * Single source of truth for all application state
 * Uses subscription pattern for reactive updates
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { SystemLogger } from '../components/system/SystemLogger';

export interface SyncStatusData {
  status: 'idle' | 'syncing' | 'synced' | 'error';
  count?: number;
  timestamp?: number;
  error?: string;
}

export interface UserState {
  isAuthenticated: boolean;
  npub: string | null;
  pubkey: string | null;
  followingPubkeys: string[];
  syncStatus?: SyncStatusData;
}

export interface TimelineState {
  events: NostrEvent[];
  hasMore: boolean;
  loading: boolean;
  includeReplies: boolean;
  lastLoadedTimestamp: number;
  scrollPosition: number;
  selectedRelay: string | null; // null = all relays, string = specific relay URL
}

export interface ViewState {
  currentView: 'timeline' | 'single-note' | 'profile' | 'messages' | 'settings' | 'login' | 'article' | 'notifications' | 'about' | 'conversation' | 'write-article' | 'edit-article' | 'articles' | 'relay-browser';
  currentNoteId?: string;
  currentProfileNpub?: string;
  currentArticleNaddr?: string;
  currentRelayUrl?: string;
  profileScrollPosition?: number;
  params?: Record<string, string>;
}

export interface ProfileSearchState {
  isActive: boolean;
  pubkeyHex: string | null;
  searchTerms: string;
  results: NostrEvent[];
  matchCount: number;
  totalNotes: number;
  scrollPosition: number;
  dateRange: {
    start: string;
    end: string;
  };
  navigatedToSNV: boolean;
}

export interface AppStateData {
  user: UserState;
  timeline: TimelineState;
  view: ViewState;
  profileSearch: ProfileSearchState;
}

type StateKey = keyof AppStateData;
type StateCallback<K extends StateKey> = (state: AppStateData[K]) => void;

export class AppState {
  private static instance: AppState;
  private systemLogger: SystemLogger;

  private state: AppStateData = {
    user: {
      isAuthenticated: false,
      npub: null,
      pubkey: null,
      followingPubkeys: []
    },
    timeline: {
      events: [],
      hasMore: true,
      loading: false,
      includeReplies: false,
      lastLoadedTimestamp: 0,
      scrollPosition: 0,
      selectedRelay: null
    },
    view: {
      currentView: 'timeline',
      profileScrollPosition: 0
    },
    profileSearch: {
      isActive: false,
      pubkeyHex: null,
      searchTerms: '',
      results: [],
      matchCount: 0,
      totalNotes: 0,
      scrollPosition: 0,
      dateRange: {
        start: 'N/A',
        end: 'N/A'
      },
      navigatedToSNV: false
    }
  };

  private subscribers: Map<StateKey, Set<StateCallback<any>>> = new Map();

  private constructor() {
    this.systemLogger = SystemLogger.getInstance();

    // Initialize subscriber maps
    this.subscribers.set('user', new Set());
    this.subscribers.set('timeline', new Set());
    this.subscribers.set('view', new Set());
    this.subscribers.set('profileSearch', new Set());
  }

  public static getInstance(): AppState {
    if (!AppState.instance) {
      AppState.instance = new AppState();
    }
    return AppState.instance;
  }

  /**
   * Get current state (immutable)
   */
  public getState<K extends StateKey>(key: K): AppStateData[K] {
    return { ...this.state[key] } as AppStateData[K];
  }

  /**
   * Get entire state (immutable)
   */
  public getAllState(): AppStateData {
    return {
      user: { ...this.state.user },
      timeline: { ...this.state.timeline },
      view: { ...this.state.view },
      profileSearch: { ...this.state.profileSearch }
    };
  }

  /**
   * Update state and notify subscribers
   */
  public setState<K extends StateKey>(key: K, updates: Partial<AppStateData[K]>): void {
    // Merge updates into existing state
    this.state[key] = {
      ...this.state[key],
      ...updates
    } as AppStateData[K];

    // Notify all subscribers for this state key
    this.notifySubscribers(key);

    // Hollywood-style state logs
    this.logStateChange(key, updates);
  }

  /**
   * Log state changes in Hollywood-style
   */
  private logStateChange<K extends StateKey>(key: K, updates: Partial<AppStateData[K]>): void {
    if (key === 'view') {
      const viewState = updates as Partial<ViewState>;
      if (viewState.currentView) {
        const viewMessages: { [key: string]: string } = {
          'timeline': '📱 Switched to Timeline View',
          'single-note': '📄 Switched to Single Note View',
          'profile': '👤 Switched to Profile View',
          'settings': '⚙️ Switched to Settings View',
          'messages': '💬 Switched to Messages View'
        };
        const message = viewMessages[viewState.currentView] || `Switched to ${viewState.currentView}`;
        this.systemLogger.info('AppState', message);
      }
    } else if (key === 'user') {
      const userState = updates as Partial<UserState>;
      if (userState.isAuthenticated === true) {
        this.systemLogger.info('AppState', '👤 User authenticated');
      } else if (userState.isAuthenticated === false) {
        this.systemLogger.info('AppState', '👤 User logged out');
      }
    } else if (key === 'profileSearch') {
      const searchState = updates as Partial<ProfileSearchState>;
      if (searchState.isActive === true && searchState.searchTerms) {
        this.systemLogger.info('AppState', `🔍 Search activated: "${searchState.searchTerms}"`);
      } else if (searchState.isActive === false) {
        this.systemLogger.info('AppState', '🔍 Search deactivated');
      }
      if (searchState.scrollPosition !== undefined && searchState.scrollPosition > 0) {
        this.systemLogger.info('AppState', `📜 Search scroll position saved: ${searchState.scrollPosition}px`);
      }
    }
    // timeline state changes are not logged (too spammy)
  }

  /**
   * Subscribe to state changes
   * @returns Unsubscribe function
   */
  public subscribe<K extends StateKey>(
    key: K,
    callback: StateCallback<K>
  ): () => void {
    const callbacks = this.subscribers.get(key);
    if (callbacks) {
      callbacks.add(callback);
    }

    // Immediately call with current state
    callback(this.getState(key));

    // Return unsubscribe function
    return () => {
      const callbacks = this.subscribers.get(key);
      if (callbacks) {
        callbacks.delete(callback);
      }
    };
  }

  /**
   * Notify all subscribers of a state change
   */
  private notifySubscribers<K extends StateKey>(key: K): void {
    const callbacks = this.subscribers.get(key);
    if (callbacks) {
      const currentState = this.getState(key);
      callbacks.forEach(callback => callback(currentState));
    }
  }

  /**
   * Reset entire state (useful for logout)
   */
  public reset(): void {
    this.state = {
      user: {
        isAuthenticated: false,
        npub: null,
        pubkey: null,
        followingPubkeys: []
      },
      timeline: {
        events: [],
        hasMore: true,
        loading: false,
        includeReplies: false,
        lastLoadedTimestamp: 0,
        scrollPosition: 0,
        selectedRelay: null
      },
      view: {
        currentView: 'timeline',
        profileScrollPosition: 0
      },
      profileSearch: {
        isActive: false,
        pubkeyHex: null,
        searchTerms: '',
        results: [],
        matchCount: 0,
        totalNotes: 0,
        scrollPosition: 0,
        dateRange: {
          start: 'N/A',
          end: 'N/A'
        },
        navigatedToSNV: false
      }
    };

    // Notify all subscribers
    this.notifySubscribers('user');
    this.notifySubscribers('timeline');
    this.notifySubscribers('view');
    this.notifySubscribers('profileSearch');

    this.systemLogger.info('AppState', '🔄 State reset to defaults');
  }

  /**
   * Debug: Log current state
   */
  public debug(): void {
    this.systemLogger.info('AppState', '📊 Current state:', this.getAllState());
  }
}
