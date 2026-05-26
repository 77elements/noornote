/**
 * Central State Manager (Singleton)
 *
 * Facade over 4 domain-specific StateStores. Public API is unchanged —
 * consumers continue using getState('key'), setState('key', updates),
 * subscribe('key', cb). Internally each domain is a separate store.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { StateStore } from '../core/StateStore';
import { SystemLogger } from './SystemLogger';

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
  selectedRelay: string | null;
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

const USER_DEFAULTS: UserState = {
  isAuthenticated: false,
  npub: null,
  pubkey: null,
  followingPubkeys: []
};

const TIMELINE_DEFAULTS: TimelineState = {
  events: [],
  hasMore: true,
  loading: false,
  includeReplies: false,
  lastLoadedTimestamp: 0,
  scrollPosition: 0,
  selectedRelay: null
};

const VIEW_DEFAULTS: ViewState = {
  currentView: 'timeline',
  profileScrollPosition: 0
};

const PROFILE_SEARCH_DEFAULTS: ProfileSearchState = {
  isActive: false,
  pubkeyHex: null,
  searchTerms: '',
  results: [],
  matchCount: 0,
  totalNotes: 0,
  scrollPosition: 0,
  dateRange: { start: 'N/A', end: 'N/A' },
  navigatedToSNV: false
};

export class AppState {
  private static instance: AppState;
  private systemLogger: SystemLogger;

  // Domain stores
  private stores = {
    user: new StateStore<UserState>(USER_DEFAULTS),
    timeline: new StateStore<TimelineState>(TIMELINE_DEFAULTS),
    view: new StateStore<ViewState>(VIEW_DEFAULTS),
    profileSearch: new StateStore<ProfileSearchState>(PROFILE_SEARCH_DEFAULTS),
  };

  private constructor() {
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): AppState {
    if (!AppState.instance) {
      AppState.instance = new AppState();
    }
    return AppState.instance;
  }

  public getState<K extends StateKey>(key: K): AppStateData[K] {
    return this.stores[key].get() as AppStateData[K];
  }

  public getAllState(): AppStateData {
    return {
      user: this.stores.user.get(),
      timeline: this.stores.timeline.get(),
      view: this.stores.view.get(),
      profileSearch: this.stores.profileSearch.get(),
    };
  }

  public setState<K extends StateKey>(key: K, updates: Partial<AppStateData[K]>): void {
    (this.stores[key] as StateStore<any>).set(updates);
    this.logStateChange(key, updates);
  }

  public subscribe<K extends StateKey>(key: K, callback: StateCallback<K>): () => void {
    return (this.stores[key] as StateStore<any>).subscribe(callback);
  }

  public reset(): void {
    this.stores.user.reset(USER_DEFAULTS);
    this.stores.timeline.reset(TIMELINE_DEFAULTS);
    this.stores.view.reset(VIEW_DEFAULTS);
    this.stores.profileSearch.reset(PROFILE_SEARCH_DEFAULTS);
    this.systemLogger.info('AppState', '🔄 State reset to defaults');
  }

  public debug(): void {
    this.systemLogger.info('AppState', '📊 Current state:', this.getAllState());
  }

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
    }
  }
}
