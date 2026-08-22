import { AddonToggleView } from '../AddonToggleView';
import { isBookmarksEnabled, setBookmarksEnabled } from './index';

export class BookmarksAddonView extends AddonToggleView {
  constructor() {
    super({
      id: 'bookmarks',
      name: 'Bookmarks',
      description:
        'Save notes and links to bookmark folders with drag-and-drop organization.',
      toggleEvent: 'bookmarks:addon-toggle',
      isEnabled: () => isBookmarksEnabled(),
      setEnabled: v => setBookmarksEnabled(v),
    });
  }
}
