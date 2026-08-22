import { AddonToggleView } from '../AddonToggleView';
import { isExtendedFollowsEnabled, setExtendedFollowsEnabled } from './index';

export class ExtendedFollowsAddonView extends AddonToggleView {
  constructor() {
    super({
      id: 'extended-follows',
      name: 'Extended Follows',
      description:
        'Mutual badges, Zap In/Out stats, and mutual change detection for your follows list.',
      toggleEvent: 'extended-follows:toggle',
      isEnabled: () => isExtendedFollowsEnabled(),
      setEnabled: v => setExtendedFollowsEnabled(v),
    });
  }
}
