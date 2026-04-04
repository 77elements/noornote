import { SettingsSubPageView } from './SettingsSubPageView';
import { NWCSettingsSection } from '../../settings/NWCSettingsSection';

export class NWCSettingsView extends SettingsSubPageView {
  constructor() {
    super('Zaps', new NWCSettingsSection());
  }
}
