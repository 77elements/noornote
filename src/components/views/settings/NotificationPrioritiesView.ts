import { SettingsSubPageView } from './SettingsSubPageView';
import { NotificationPrioritySection } from '../../settings/NotificationPrioritySection';

export class NotificationPrioritiesView extends SettingsSubPageView {
  constructor() {
    super('Notification Priorities', new NotificationPrioritySection());
  }
}
