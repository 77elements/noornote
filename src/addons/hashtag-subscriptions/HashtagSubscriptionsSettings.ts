/**
 * HashtagSubscriptionsSettings Component
 * Settings UI for hashtag subscription addon
 *
 * @purpose Enable/disable addon + manage subscriptions
 * @used-by SettingsView (Add-ons section)
 */

import { SettingsSection } from '../../components/settings/SettingsSection';
import { Switch } from '../../components/ui/Switch';
import { ToastService } from '../../services/ToastService';
import { EventBus } from '../../services/EventBus';
import { isHashtagSubscriptionsEnabled, setHashtagSubscriptionsEnabled } from './index';

// Lazy-loaded types
type HashtagNotificationServiceType = import('./HashtagNotificationService').HashtagNotificationService;

export class HashtagSubscriptionsSettings extends SettingsSection {
  private enableSwitch: Switch | null = null;
  private eventBus: EventBus;
  private hashtagService: HashtagNotificationServiceType | null = null;
  private subscriptionEventId: string | null = null;

  constructor() {
    super('hashtag-subscriptions-settings');
    this.eventBus = EventBus.getInstance();
  }

  public mount(parentContainer: HTMLElement): void {
    const contentContainer = this.getContentContainer(parentContainer);
    if (!contentContainer) return;

    const contentZone = parentContainer.querySelector('[data-addon-content="hashtag-subscriptions"]') as HTMLElement | null;

    const enabled = isHashtagSubscriptionsEnabled();

    this.enableSwitch = new Switch({
      label: '',
      checked: enabled,
      onChange: async (checked) => {
        setHashtagSubscriptionsEnabled(checked);
        // Notify the AddonLoader — it owns the polling lifecycle via the
        // addon runtime. On toggle ON it will load the runtime and start
        // polling; on toggle OFF it will call service.destroy() which
        // stopsPolling and releases the singleton.
        this.eventBus.emit('hashtag-subscriptions:addon-toggle', { enabled: checked });
        if (checked) {
          await this.loadService();
          ToastService.show('Hashtag Subscriptions enabled', 'success');
        } else {
          ToastService.show('Hashtag Subscriptions disabled', 'success');
        }
        if (contentZone) this.renderContent(contentZone, checked);
      }
    });

    contentContainer.innerHTML = `
      <div class="setting">
        <span class="setting__label">Enable Hashtag Subscriptions</span>
        <div class="setting__control">${this.enableSwitch.render()}</div>
        <p class="setting__desc">Subscribe to any hashtag or word and get notified when someone posts a note containing it.</p>
      </div>
    `;
    this.enableSwitch.setupEventListeners(contentContainer);

    if (enabled && contentZone) {
      this.loadService().then(() => this.renderContent(contentZone, true));
    }

    // Listen for subscription updates
    this.subscriptionEventId = this.eventBus.on('hashtag-subscription:updated', () => {
      if (isHashtagSubscriptionsEnabled() && contentZone) {
        this.renderSubscriptionsList(contentZone);
      }
    });
  }

  private async loadService(): Promise<void> {
    if (this.hashtagService) return;
    const { HashtagNotificationService } = await import('./HashtagNotificationService');
    this.hashtagService = HashtagNotificationService.getInstance();
  }

  private renderContent(contentContainer: HTMLElement, enabled: boolean): void {
    // Remove existing content
    const existing = contentContainer.querySelector('.hashtag-subscriptions__content');
    if (existing) existing.remove();

    if (!enabled) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'hashtag-subscriptions__content';
    wrapper.innerHTML = `
      <div class="subscription-search">
        <input
          type="text"
          class="input"
          data-subscription-input
          placeholder="Enter hashtag (without #)"
        />
        <button class="btn btn--medium hashtag-search-btn">Search</button>
      </div>
      <div class="hashtag-subscriptions-list ui-list"></div>
    `;

    contentContainer.appendChild(wrapper);
    this.bindSearchHandler(wrapper);
    this.renderSubscriptionsList(contentContainer);
  }

  private bindSearchHandler(wrapper: HTMLElement): void {
    const searchBtn = wrapper.querySelector('.hashtag-search-btn');
    const searchInput = wrapper.querySelector('[data-subscription-input]') as HTMLInputElement;
    if (!searchBtn || !searchInput) return;

    const handleSearch = () => {
      const hashtag = searchInput.value.trim().replace(/^#/, '');
      if (hashtag) {
        this.eventBus.emit('hashtagSearch:start', { hashtag });
        searchInput.value = '';
      }
    };

    searchBtn.addEventListener('click', handleSearch);
    searchInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleSearch();
    });
  }

  private renderSubscriptionsList(contentContainer: HTMLElement): void {
    const listContainer = contentContainer.querySelector('.hashtag-subscriptions-list');
    if (!listContainer || !this.hashtagService) return;

    const subscriptions = this.hashtagService.getAllSubscriptions();

    if (subscriptions.length === 0) {
      listContainer.innerHTML = '<p class="muted">No hashtag subscriptions yet</p>';
      return;
    }

    listContainer.innerHTML = subscriptions.map(({ hashtag, subscription }) => `
      <div class="ui-list__item subscription-row">
        <span class="subscription-hashtag">#${hashtag}</span>
        <div class="subscription-actions">
          <div class="switch-container">
            <label class="switch-label" title="Also search for '${hashtag}' without #">
              <span class="switch-text">also ${hashtag}</span>
              <div class="switch-toggle">
                <input
                  type="checkbox"
                  class="switch-input"
                  data-action="toggle-include-without-hash"
                  data-hashtag="${hashtag}"
                  ${subscription.includeWithoutHash ? 'checked' : ''}
                />
                <span class="switch-slider"></span>
              </div>
            </label>
          </div>
          <button class="btn btn--mini btn--danger" data-action="unsubscribe-hashtag" data-hashtag="${hashtag}">
            Unsubscribe
          </button>
        </div>
      </div>
    `).join('');

    // Attach unsubscribe handlers
    listContainer.querySelectorAll('[data-action="unsubscribe-hashtag"]').forEach(button => {
      button.addEventListener('click', () => {
        const hashtag = (button as HTMLElement).dataset.hashtag;
        if (hashtag) this.hashtagService?.unsubscribe(hashtag);
      });
    });

    // Attach toggle handlers
    listContainer.querySelectorAll('[data-action="toggle-include-without-hash"]').forEach(input => {
      input.addEventListener('change', (e) => {
        const target = e.target as HTMLInputElement;
        const hashtag = target.dataset.hashtag;
        if (hashtag) {
          this.hashtagService?.setIncludeWithoutHash(hashtag, target.checked);
          const msg = target.checked
            ? `Now also searching for "${hashtag}" without #`
            : `Only searching for #${hashtag}`;
          ToastService.show(msg, 'success');
        }
      });
    });
  }

  public unmount(): void {
    if (this.subscriptionEventId) {
      this.eventBus.off(this.subscriptionEventId);
    }
    this.enableSwitch = null;
  }
}
