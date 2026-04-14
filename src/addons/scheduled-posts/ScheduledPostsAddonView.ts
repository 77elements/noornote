import { AddonToggleView } from '../AddonToggleView';
import { isScheduledPostsEnabled, setScheduledPostsEnabled } from './index';

export class ScheduledPostsAddonView extends AddonToggleView {
  constructor() {
    super({
      id: 'scheduled-posts',
      name: 'Scheduled Posts',
      description:
        'Schedule notes and articles to be published at a later date and time. Your fully signed event is held by a NoorNote-operated Deno service and published to your chosen relays at the scheduled moment. No private keys leave your device.',
      toggleEvent: 'scheduled-posts:addon-toggle',
      isEnabled: () => isScheduledPostsEnabled(),
      setEnabled: (v) => setScheduledPostsEnabled(v),
    });
  }
}
