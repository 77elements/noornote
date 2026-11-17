import { View } from '../../components/views/View';
import {
  ContentWordFilterSettings,
  mountWordFilterContent,
} from './ContentWordFilterSettings';
import { TypedEventBus } from '../../core/TypedEventBus';
import { isContentWordFilterEnabled, isWordFilterAutoLoaded } from './index';
import { isFocusUiEnabled } from '../../helpers/focusUiSetting';
import { AddonLoader } from '../AddonLoader';
import { _ } from '../../i18n';

export class WordFilterAddonView extends View {
  private container: HTMLElement;
  private contentEl: HTMLElement | null = null;
  private settings: ContentWordFilterSettings | null = null;
  private toggleSubId: string | null = null;
  /** v2 on-demand object lifecycle (see NostrMajlisAddonView.v2OnDemand). */
  private readonly v2OnDemand = isFocusUiEnabled();

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className =
      'view-content view-content--addon view-content--addon-wordfilter';
    // v2 on-demand: the object loads the addon while it is open — released
    // again in destroy() unless words are configured (always-on reason).
    if (this.v2OnDemand) {
      void AddonLoader.getInstance().ensureLoaded('wordfilter');
    }
    this.container.innerHTML = `
      <div class="back-padder">
        <h1>${_('Word Filter')}</h1>
        <section class="section" id="content-word-filter-settings-content"></section>
        <div data-addon-content="wordfilter"></div>
      </div>
    `;
    this.settings = new ContentWordFilterSettings();
    this.settings.mount(this.container);

    this.contentEl = this.container.querySelector(
      '[data-addon-content="wordfilter"]'
    ) as HTMLElement;

    if (isContentWordFilterEnabled()) {
      this.mountContent();
    }

    this.toggleSubId = TypedEventBus.getInstance().on(
      'content-word-filter:toggle',
      (payload: { enabled: boolean }) => {
        if (payload.enabled) this.mountContent();
        else this.unmountContent();
      }
    );
  }

  private mountContent(): void {
    if (!this.contentEl || this.contentEl.childElementCount > 0) return;
    mountWordFilterContent(this.contentEl);
  }

  private unmountContent(): void {
    if (this.contentEl) this.contentEl.innerHTML = '';
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    if (this.toggleSubId) {
      TypedEventBus.getInstance().off(this.toggleSubId);
      this.toggleSubId = null;
    }
    this.settings?.unmount();
    this.settings = null;
    this.container.innerHTML = '';
    this.contentEl = null;
    // v2 on-demand release: unload after the object is left — unless the
    // user has words configured (the filter stays active in the feeds).
    if (this.v2OnDemand && !isWordFilterAutoLoaded()) {
      void AddonLoader.getInstance().deactivateOnDemand('wordfilter');
    }
  }
}
