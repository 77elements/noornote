import { View } from '../../components/views/View';
import { GroupChatsSettings } from './GroupChatsSettings';
import { AddonLoader } from '../AddonLoader';
import { isArmadaEnabled, isGroupChatsEnabled } from './index';
import { isFocusUiEnabled } from '../../helpers/focusUiSetting';
import { _ } from '../../i18n';

export class GroupChatsAddonView extends View {
  private container: HTMLElement;
  private settings: GroupChatsSettings | null = null;
  /**
   * v2 on-demand object lifecycle (see CustomEmojisView.v2OnDemand):
   * loads on enter, releases on leave — unless Nostrord or Armada is
   * user-enabled (the switches are real preferences: ON means the
   * community polling must keep running while the object is closed).
   */
  private readonly v2OnDemand = isFocusUiEnabled();

  constructor() {
    super();
    this.container = document.createElement('div');
    // CSS class retains the legacy `--addon-group-chats` slug — the addon id and
    // route stay `group-chats` for backward compat (existing bookmarks, saved
    // flags), only the user-facing label changed to "Group Chats" when Armada
    // support was added alongside NIP-29 in v1.3.4.
    this.container.className =
      'view-content view-content--addon view-content--addon-group-chats';
    // v2 on-demand: the object loads the addon regardless of the stored
    // preference — the settings render either way. Released in destroy().
    if (this.v2OnDemand) {
      void AddonLoader.getInstance().ensureLoaded('group-chats');
    }
    this.container.innerHTML = `
      <div class="back-padder focus-flow-root">
        <h1>${_('Group Chats')}</h1>
        <p class="form__note">
          Heads-up notifications when your group chat communities come alive.
          Currently supports Nostrord (NIP-29) and Armada (Concord).
        </p>
        <section class="section" id="group-chats-settings-content"></section>
        <div data-addon-content="armada-communities"></div>
        <div data-addon-content="group-chats"></div>
      </div>
    `;
    this.settings = new GroupChatsSettings();
    this.settings.mount(this.container);
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.settings?.unmount();
    this.settings = null;
    this.container.innerHTML = '';
    // v2 on-demand release: unload after the object is left — unless
    // Nostrord or Armada is user-enabled (their always-on reason).
    if (this.v2OnDemand && !isGroupChatsEnabled() && !isArmadaEnabled()) {
      void AddonLoader.getInstance().deactivateOnDemand('group-chats');
    }
  }
}
