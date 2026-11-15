/**
 * ScheduledPostsAddonView
 *
 * View for the Scheduled Posts addon page (`/addons/scheduled-posts`).
 * Classic (v1): shows the enable toggle on top, followed by a list of
 * pending scheduled posts below — but only while the addon is enabled.
 * Focus UI (v2): on-demand addon — the toggle is hidden, the list is
 * always shown, and the addon code loads while the view is open and
 * unloads again when the user leaves it (see AddonLoader.ensureLoaded).
 */

import { View } from '../../components/views/View';
import { Switch } from '../../components/ui/Switch';
import { TypedEventBus } from '../../core/TypedEventBus';
import { ToastService } from '../../services/ToastService';
import { isScheduledPostsEnabled, setScheduledPostsEnabled } from './index';
import { AddonLoader } from '../AddonLoader';
import { isFocusUiEnabled } from '../../helpers/focusUiSetting';
import { ScheduledPostsList } from './ScheduledPostsList';
import { _ } from '../../i18n';

export class ScheduledPostsAddonView extends View {
  private container: HTMLElement;
  private contentEl: HTMLElement | null = null;
  private enableSwitch: Switch | null = null;
  private toggleSubId: string | null = null;
  private postsList: ScheduledPostsList | null = null;
  /**
   * v2 on-demand addon lifecycle: in the Focus UI the stored preference no
   * longer gates this view — the addon loads while the view is open and
   * unloads again when the user leaves it (X button). The enable switch
   * is hidden there; the preference stays untouched.
   */
  private readonly v2OnDemand = isFocusUiEnabled();

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className =
      'view-content view-content--addon view-content--addon-scheduled-posts';

    const enabled = isScheduledPostsEnabled();

    if (!this.v2OnDemand) {
      this.enableSwitch = new Switch({
        label: '',
        checked: enabled,
        onChange: checked => {
          setScheduledPostsEnabled(checked);
          TypedEventBus.getInstance().emit('scheduled-posts:addon-toggle', {
            enabled: checked,
          });
          ToastService.show(
            checked
              ? _('%s enabled', _('Scheduled Posts'))
              : _('%s disabled', _('Scheduled Posts')),
            'success'
          );
          if (checked) this.mountList();
          else this.unmountList();
        },
      });
    }

    this.container.innerHTML = `
      <div class="back-padder">
        <h1>${_('Scheduled Posts')}</h1>
        ${
          this.v2OnDemand
            ? ''
            : `
        <section class="section">
          <div class="setting">
            <span class="setting__label">${_('Enable Scheduled Posts')}</span>
            <div class="setting__control"></div>
            <p class="setting__desc">${_('Schedule notes and articles to be published at a later date and time. Your fully signed event is held by a NoorNote-operated Deno service and published to your chosen relays at the scheduled moment. No private keys leave your device.')}</p>
          </div>
        </section>`
        }
        <div data-addon-content="scheduled-posts"></div>
      </div>
    `;

    const controlEl = this.container.querySelector('.setting__control');
    if (controlEl && this.enableSwitch) {
      controlEl.innerHTML = this.enableSwitch.render();
      this.enableSwitch.setupEventListeners(this.container);
    }

    this.contentEl = this.container.querySelector(
      '[data-addon-content="scheduled-posts"]'
    );

    if (this.v2OnDemand) {
      // On-demand: load the addon code while the view is open, regardless
      // of the stored preference; released again in destroy().
      void AddonLoader.getInstance().ensureLoaded('scheduled-posts');
      this.mountList();
    } else if (enabled) {
      this.mountList();
    }

    this.toggleSubId = TypedEventBus.getInstance().on(
      'scheduled-posts:addon-toggle',
      (payload: { enabled: boolean }) => {
        if (payload.enabled) this.mountList();
        else this.unmountList();
      }
    );

    // The list component owns the 'scheduled-posts:changed' refresh while
    // it is mounted — no view-level subscription needed.
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    if (this.toggleSubId) {
      TypedEventBus.getInstance().off(this.toggleSubId);
      this.toggleSubId = null;
    }
    this.enableSwitch?.destroy();
    this.enableSwitch = null;
    this.unmountList();
    this.contentEl = null;
    this.container.innerHTML = '';
    // v2 on-demand: leaving the addon view releases the addon again
    // (unless the user permanently enabled it via the stored preference).
    if (this.v2OnDemand && !isScheduledPostsEnabled()) {
      void AddonLoader.getInstance().deactivateOnDemand('scheduled-posts');
    }
  }

  private mountList(): void {
    if (!this.contentEl) return;
    this.contentEl.innerHTML = `<h2>${_('Your scheduled posts')}</h2>`;
    const listEl = document.createElement('div');
    listEl.className = 'ui-list';
    this.contentEl.appendChild(listEl);
    this.postsList = new ScheduledPostsList();
    this.postsList.mount(listEl);
  }

  private unmountList(): void {
    this.postsList?.destroy();
    this.postsList = null;
    if (this.contentEl) this.contentEl.innerHTML = '';
  }
}
