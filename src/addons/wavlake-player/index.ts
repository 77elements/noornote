import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';

const STORAGE_KEY = 'noornote_wavlake_player_enabled';

export function isWavlakePlayerEnabled(): boolean {
  const perAccount = PerAccountLocalStorage.getInstance().get<boolean | null>(
    StorageKeys.WAVLAKE_PLAYER_ENABLED, null
  );
  if (perAccount !== null) return perAccount;
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function setWavlakePlayerEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.WAVLAKE_PLAYER_ENABLED, enabled);
  localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
}

// op3.dev play-stats. Default OFF = strip the op3 redirect for maximum privacy
// (mp3 loads directly from Wavlake's CDN). Opt-in keeps the redirect so the
// artist gets play statistics — at the cost of leaking the user's IP to op3.dev
// on Play.
export function isWavlakeKeepOp3Enabled(): boolean {
  return PerAccountLocalStorage.getInstance().get<boolean>(StorageKeys.WAVLAKE_PLAYER_KEEP_OP3, false);
}

export function setWavlakeKeepOp3Enabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.WAVLAKE_PLAYER_KEEP_OP3, enabled);
}
