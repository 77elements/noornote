import { SettingsSubPageView } from './SettingsSubPageView';
import { PrivacySettingsSection } from '../../settings/PrivacySettingsSection';

export class PrivacySettingsView extends SettingsSubPageView {
  constructor() {
    super('Privacy Settings', new PrivacySettingsSection());
  }
}
