import { SettingsSubPageView } from './SettingsSubPageView';
import { KeySignerSection } from '../../settings/KeySignerSection';
import { KeySignerClient } from '../../../services/KeySignerClient';

export class KeySignerView extends SettingsSubPageView {
  constructor() {
    super('Key Signer', new KeySignerSection(KeySignerClient.getInstance()));
  }
}
