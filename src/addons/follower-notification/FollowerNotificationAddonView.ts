import { View } from '../../components/views/View';
import { FollowerNotificationSettings } from './FollowerNotificationSettings';
import { AddonLoader } from '../AddonLoader';
import { isFollowerNotificationEnabled } from './index';
import { isFocusUiEnabled } from '../../helpers/focusUiSetting';
import { _ } from '../../i18n';

export class FollowerNotificationAddonView extends View {
  private container: HTMLElement;
  private settings: FollowerNotificationSettings | null = null;
  /**
   * v2 on-demand object lifecycle (see CustomEmojisView.v2OnDemand):
   * loads on enter, releases on leave — unless the user enabled the
   * notification system (the switch is a real preference: ON means the
   * follower scan must keep running while the object is closed).
   */
  private readonly v2OnDemand = isFocusUiEnabled();

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className =
      'view-content view-content--addon view-content--addon-follower-notification';
    // v2 on-demand: the object loads the addon regardless of the stored
    // preference — the settings render either way. Released in destroy().
    if (this.v2OnDemand) {
      void AddonLoader.getInstance().ensureLoaded('follower-notification');
    }
    this.container.innerHTML = `
      <div class="back-padder focus-flow-root">
        <h1>${_('Follower Alerts')}</h1>
        <section class="section" id="follower-notification-settings-content"></section>
        <div data-addon-content="follower-notification"></div>
      </div>
    `;
    this.settings = new FollowerNotificationSettings();
    this.settings.mount(this.container);
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.settings?.unmount();
    this.settings = null;
    this.container.innerHTML = '';
    // v2 on-demand release: unload after the object is left — unless the
    // notification system is user-enabled (its always-on reason).
    if (this.v2OnDemand && !isFollowerNotificationEnabled()) {
      void AddonLoader.getInstance().deactivateOnDemand(
        'follower-notification'
      );
    }
  }
}
