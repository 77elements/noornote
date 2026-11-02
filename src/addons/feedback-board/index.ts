import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../services/PerAccountLocalStorage';

const STORAGE_KEY = 'noornote_feedback_board_enabled';

export function isFeedbackBoardEnabled(): boolean {
  const perAccount = PerAccountLocalStorage.getInstance().get<boolean | null>(
    StorageKeys.FEEDBACK_BOARD_ENABLED,
    null
  );
  if (perAccount !== null) return perAccount;
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function setFeedbackBoardEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(
    StorageKeys.FEEDBACK_BOARD_ENABLED,
    enabled
  );
  localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
}
