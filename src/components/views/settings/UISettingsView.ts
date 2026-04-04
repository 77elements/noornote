import { SettingsSubPageView } from './SettingsSubPageView';
import { UISettingsSection } from '../../settings/UISettingsSection';

export class UISettingsView extends SettingsSubPageView {
  constructor() {
    super('UI Settings', new UISettingsSection());
  }
}
