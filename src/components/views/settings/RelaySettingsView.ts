import { SettingsSubPageView } from './SettingsSubPageView';
import { RelaySettingsSection } from '../../settings/RelaySettingsSection';

export class RelaySettingsView extends SettingsSubPageView {
  constructor() {
    super('Relay Settings', new RelaySettingsSection());
  }
}
