import { AddonToggleView } from '../AddonToggleView';
import { isTribesEnabled, setTribesEnabled } from './index';

export class TribesAddonView extends AddonToggleView {
  constructor() {
    super({
      id: 'tribes',
      name: 'Tribes',
      description:
        'Create custom user groups and view dedicated tribe timelines.',
      toggleEvent: 'tribes:addon-toggle',
      isEnabled: () => isTribesEnabled(),
      setEnabled: v => setTribesEnabled(v),
    });
  }
}
