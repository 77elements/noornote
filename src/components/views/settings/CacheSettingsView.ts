import { SettingsSubPageView } from './SettingsSubPageView';
import { CacheSettingsSection } from '../../settings/CacheSettingsSection';

export class CacheSettingsView extends SettingsSubPageView {
  constructor() {
    super('Cache Settings', new CacheSettingsSection());
  }
}
