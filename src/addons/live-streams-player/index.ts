import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../services/PerAccountLocalStorage';

const STORAGE_KEY = 'noornote_live_streams_player_enabled';

export function isLiveStreamsPlayerEnabled(): boolean {
  const perAccount = PerAccountLocalStorage.getInstance().get<boolean | null>(
    StorageKeys.LIVE_STREAMS_PLAYER_ENABLED,
    null
  );
  if (perAccount !== null) return perAccount;
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function setLiveStreamsPlayerEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(
    StorageKeys.LIVE_STREAMS_PLAYER_ENABLED,
    enabled
  );
  localStorage.setItem(STORAGE_KEY, 'false');
}
