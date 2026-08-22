import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../services/PerAccountLocalStorage';

export type SccDefaultContent = 'system-log' | 'newest-articles' | 'media';

export function getSccDefaultTab(): SccDefaultContent {
  return PerAccountLocalStorage.getInstance().get<SccDefaultContent>(
    StorageKeys.SCC_DEFAULT_CONTENT,
    'system-log'
  );
}

export function setSccDefaultTab(value: SccDefaultContent): void {
  PerAccountLocalStorage.getInstance().set(
    StorageKeys.SCC_DEFAULT_CONTENT,
    value
  );
}
