import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../services/PerAccountLocalStorage';

/**
 * Pre-rename global localStorage flag. Once the addon is toggled (or was
 * migrated), it is written 'false' so it never overrides the per-account value.
 */
const LEGACY_LOCAL_KEY = 'noornote_live_streams_player_enabled';

export function isLiveStreamsEnabled(): boolean {
  const perAccount = PerAccountLocalStorage.getInstance();
  const current = perAccount.get<boolean | null>(
    StorageKeys.LIVE_STREAMS_ENABLED,
    null
  );
  if (current !== null) return current;
  // Migration: fall back to the pre-rename per-account key, then the
  // pre-rename global localStorage flag. Legacy PAL keys are never renamed
  // away — they stay readable as a fallback chain.
  const legacy = perAccount.get<boolean | null>(
    StorageKeys.LIVE_STREAMS_PLAYER_ENABLED,
    null
  );
  if (legacy !== null) return legacy;
  return localStorage.getItem(LEGACY_LOCAL_KEY) === 'true';
}

export function setLiveStreamsEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(
    StorageKeys.LIVE_STREAMS_ENABLED,
    enabled
  );
  localStorage.setItem(LEGACY_LOCAL_KEY, 'false');
}

/**
 * Show the "currently live" widget for followed users in the sidebar.
 * The widget only renders when at least one followed user is actually live —
 * an empty sidebar slot is preferable to a "nothing is streaming" placeholder.
 */
export function isLiveStreamsSidebarWidget(): boolean {
  return PerAccountLocalStorage.getInstance().get<boolean>(
    StorageKeys.LIVE_STREAMS_SIDEBAR_WIDGET,
    false
  );
}

export function setLiveStreamsSidebarWidget(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(
    StorageKeys.LIVE_STREAMS_SIDEBAR_WIDGET,
    enabled
  );
}
