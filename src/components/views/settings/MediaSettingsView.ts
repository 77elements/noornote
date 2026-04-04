import { SettingsSubPageView } from './SettingsSubPageView';
import { MediaServerSection } from '../../settings/MediaServerSection';

export class MediaSettingsView extends SettingsSubPageView {
  constructor() {
    super('Media', new MediaServerSection());
  }
}
