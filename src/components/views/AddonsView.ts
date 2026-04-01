/**
 * AddonsView
 *
 * Central hub for all add-ons. Vertical sub-navigation on the left,
 * content panel on the right. Each panel has two zones:
 *   1. Settings (top, separated by border-bottom via .addon-settings)
 *   2. Content (below, optional per addon)
 */

import { View } from './View';
import { Switch } from '../ui/Switch';
import { EventBus } from '../../services/EventBus';
import { ToastService } from '../../services/ToastService';
import type { SettingsSection } from '../settings/SettingsSection';

interface AddonDef {
  id: string;
  name: string;
  description: string;
  settingsContainerId: string;
  isEnabled: () => Promise<boolean>;
  setEnabled: (v: boolean) => Promise<void>;
  toggleEvent?: string;
  /** Mount the settings component (reused from SettingsView). */
  mountSettings?: (panel: HTMLElement) => Promise<SettingsSection>;
  /** Mount content below the settings separator. */
  mountContent?: (contentEl: HTMLElement) => void | Promise<void>;
}

const ADDONS: AddonDef[] = [
  {
    id: 'bookmarks',
    name: 'Bookmarks',
    description: 'Save notes and links to bookmark folders with drag-and-drop organization.',
    settingsContainerId: 'bookmarks-addon-settings-content',
    isEnabled: async () => {
      const { isBookmarksEnabled } = await import('../../addons/bookmarks/index');
      return isBookmarksEnabled();
    },
    setEnabled: async (v) => {
      const { setBookmarksEnabled } = await import('../../addons/bookmarks/index');
      setBookmarksEnabled(v);
    },
    toggleEvent: 'bookmarks:addon-toggle',
  },
  {
    id: 'tribes',
    name: 'Tribes',
    description: 'Create custom user groups and view dedicated tribe timelines.',
    settingsContainerId: 'tribes-addon-settings-content',
    isEnabled: async () => {
      const { isTribesEnabled } = await import('../../addons/tribes/index');
      return isTribesEnabled();
    },
    setEnabled: async (v) => {
      const { setTribesEnabled } = await import('../../addons/tribes/index');
      setTribesEnabled(v);
    },
    toggleEvent: 'tribes:addon-toggle',
  },
  {
    id: 'extended-follows',
    name: 'Extended Follows',
    description: 'Mutual badges, Zap In/Out stats, and mutual change detection for your follows list.',
    settingsContainerId: 'extended-follows-settings-content',
    isEnabled: async () => {
      const { isExtendedFollowsEnabled } = await import('../../addons/extended-follows/index');
      return isExtendedFollowsEnabled();
    },
    setEnabled: async (v) => {
      const { setExtendedFollowsEnabled } = await import('../../addons/extended-follows/index');
      setExtendedFollowsEnabled(v);
    },
    toggleEvent: 'extended-follows:toggle',
  },
  {
    id: 'wallet-balance',
    name: 'Wallet Balance',
    description: 'Show your Lightning wallet balance in the sidebar with fiat conversion.',
    settingsContainerId: 'wallet-balance-settings-content',
    isEnabled: async () => {
      const { isWalletBalanceEnabled } = await import('../../addons/wallet-balance/index');
      return isWalletBalanceEnabled();
    },
    setEnabled: async (v) => {
      const { setWalletBalanceEnabled } = await import('../../addons/wallet-balance/index');
      setWalletBalanceEnabled(v);
    },
    toggleEvent: 'wallet-balance:addon-toggle',
  },
  {
    id: 'profile-recognition',
    name: 'Profile Recognition',
    description: 'Help recognize people you follow after they change their profile.',
    settingsContainerId: 'profile-recognition-settings-content',
    isEnabled: async () => {
      const { isProfileRecognitionEnabled } = await import('../../addons/profile-recognition/index');
      return isProfileRecognitionEnabled();
    },
    setEnabled: async (v) => {
      const { setProfileRecognitionWindow } = await import('../../addons/profile-recognition/index');
      setProfileRecognitionWindow(v ? 90 : 0);
    },
    mountSettings: async (panel) => {
      const { ProfileRecognitionSettings } = await import('../../addons/profile-recognition/ProfileRecognitionSettings');
      const settings = new ProfileRecognitionSettings();
      settings.mount(panel);
      return settings;
    },
  },
  {
    id: 'marketplace',
    name: 'Marketplace',
    description: 'Browse classified listings (NIP-99) from the Nostr network.',
    settingsContainerId: 'marketplace-settings-content',
    isEnabled: async () => {
      const { isMarketplaceEnabled } = await import('../../addons/marketplace/index');
      return isMarketplaceEnabled();
    },
    setEnabled: async (v) => {
      const { setMarketplaceEnabled } = await import('../../addons/marketplace/index');
      setMarketplaceEnabled(v);
    },
    toggleEvent: 'marketplace:toggle',
    mountSettings: async (panel) => {
      const { MarketplaceSettingsSection } = await import('../settings/MarketplaceSettingsSection');
      const settings = new MarketplaceSettingsSection();
      settings.mount(panel);
      return settings;
    },
    mountContent: async (contentEl) => {
      const { MarketplaceTimeline } = await import('../../addons/marketplace/MarketplaceTimeline');
      const timeline = new MarketplaceTimeline();
      contentEl.appendChild(timeline.getElement());
    },
  },
  {
    id: 'follow-packs',
    name: 'Follow Packs',
    description: 'Browse curated people lists and follow entire communities at once.',
    settingsContainerId: 'follow-packs-settings-content',
    isEnabled: async () => {
      const { isFollowPacksEnabled } = await import('../../addons/follow-packs/index');
      return isFollowPacksEnabled();
    },
    setEnabled: async (v) => {
      const { setFollowPacksEnabled } = await import('../../addons/follow-packs/index');
      setFollowPacksEnabled(v);
    },
    toggleEvent: 'follow-packs:toggle',
    mountSettings: async (panel) => {
      const { FollowPacksSettings } = await import('../../addons/follow-packs/FollowPacksSettings');
      const settings = new FollowPacksSettings();
      settings.mount(panel);
      return settings;
    },
    mountContent: async (contentEl) => {
      const { FollowPackManager } = await import('../../addons/follow-packs/FollowPackManager');
      const manager = new FollowPackManager(contentEl);
      await manager.renderListTab(contentEl);
    },
  },
  {
    id: 'nostrin',
    name: 'NostrIn',
    description: 'Professional identity on Nostr — portfolio, skills, reputation.',
    settingsContainerId: 'nostrin-settings-content',
    isEnabled: async () => {
      const { isNostrInEnabled } = await import('../../addons/nostrin/index');
      return isNostrInEnabled();
    },
    setEnabled: async (v) => {
      const { setNostrInEnabled } = await import('../../addons/nostrin/index');
      setNostrInEnabled(v);
    },
    toggleEvent: 'nostrin:toggle',
    mountSettings: async (panel) => {
      const { NostrInSettings } = await import('../../addons/nostrin/NostrInSettings');
      const settings = new NostrInSettings();
      settings.mount(panel);
      return settings;
    },
  },
  {
    id: 'hashtag-subscriptions',
    name: 'Hashtag Subscriptions',
    description: 'Subscribe to hashtags and get notified when new posts are published.',
    settingsContainerId: 'hashtag-subscriptions-settings-content',
    isEnabled: async () => {
      const { isHashtagSubscriptionsEnabled } = await import('../../addons/hashtag-subscriptions/index');
      return isHashtagSubscriptionsEnabled();
    },
    setEnabled: async (v) => {
      const { setHashtagSubscriptionsEnabled } = await import('../../addons/hashtag-subscriptions/index');
      setHashtagSubscriptionsEnabled(v);
    },
    mountSettings: async (panel) => {
      const { HashtagSubscriptionsSettings } = await import('../../addons/hashtag-subscriptions/HashtagSubscriptionsSettings');
      const settings = new HashtagSubscriptionsSettings();
      settings.mount(panel);
      return settings;
    },
  },
  {
    id: 'list-settings',
    name: 'List Sync Mode',
    description: 'Enable manual sync control and advanced list options.',
    settingsContainerId: 'list-settings-content',
    isEnabled: async () => {
      const { isListSettingsEnabled } = await import('../../addons/list-settings/index');
      return isListSettingsEnabled();
    },
    setEnabled: async (v) => {
      const { setListSettingsEnabled } = await import('../../addons/list-settings/index');
      setListSettingsEnabled(v);
    },
    mountSettings: async (panel) => {
      const { ListSettingsSection } = await import('../settings/ListSettingsSection');
      const settings = new ListSettingsSection();
      settings.mount(panel);
      return settings;
    },
  },
  {
    id: 'wordfilter',
    name: 'Word Filter',
    description: 'Hide notes containing specific words from all timelines.',
    settingsContainerId: 'content-word-filter-settings-content',
    isEnabled: async () => {
      const { isContentWordFilterEnabled } = await import('../../addons/content-word-filter/index');
      return isContentWordFilterEnabled();
    },
    setEnabled: async (v) => {
      const { setContentWordFilterEnabled } = await import('../../addons/content-word-filter/index');
      setContentWordFilterEnabled(v);
    },
    toggleEvent: 'content-word-filter:toggle',
    mountSettings: async (panel) => {
      const { ContentWordFilterSettings } = await import('../../addons/content-word-filter/ContentWordFilterSettings');
      const settings = new ContentWordFilterSettings();
      settings.mount(panel);
      return settings;
    },
    mountContent: (contentEl) => {
      import('../../addons/content-word-filter/ContentWordFilterSettings').then(({ mountWordFilterContent }) => {
        mountWordFilterContent(contentEl);
      });
    },
  },
];

export class AddonsView extends View {
  private container: HTMLElement;
  private switches: Map<string, Switch> = new Map();
  private mountedSettings: Map<string, SettingsSection> = new Map();
  private activeAddonId: string;

  constructor(addonId?: string) {
    super();
    this.activeAddonId = ADDONS.find(a => a.id === addonId)?.id ?? ADDONS[0]!.id;
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--addons';
    this.init();
  }

  private async init(): Promise<void> {
    const states = new Map<string, boolean>();
    await Promise.all(ADDONS.map(async (a) => {
      states.set(a.id, await a.isEnabled());
    }));

    this.container.innerHTML = `
      <div class="addons-panel">
        ${ADDONS.map(a => `
          <div class="addons-panel__item${a.id === this.activeAddonId ? ' addons-panel__item--active' : ''}"
               data-addon-panel="${a.id}">
            <h1 class="addons-panel__title">${a.name}</h1>
            <div id="${a.settingsContainerId}" class="addon-settings"></div>
            <div class="addons-panel__content" data-addon-content="${a.id}"></div>
          </div>
        `).join('')}
      </div>
    `;

    // Mount settings components or fallback switches
    for (const addon of ADDONS) {
      if (addon.mountSettings) {
        const settings = await addon.mountSettings(this.container);
        this.mountedSettings.set(addon.id, settings);
      } else {
        this.mountFallbackSwitch(addon, states.get(addon.id) ?? false);
      }
    }

    // Mount content sections + set initial visibility
    for (const addon of ADDONS) {
      const contentEl = this.container.querySelector(`[data-addon-content="${addon.id}"]`) as HTMLElement;
      if (!contentEl) continue;

      const enabled = states.get(addon.id) ?? false;
      contentEl.style.display = enabled ? '' : 'none';

      if (addon.mountContent) {
        addon.mountContent(contentEl);
      }
    }

    // Toggle content visibility when addons are enabled/disabled
    this.bindContentVisibility();
  }

  private mountFallbackSwitch(addon: AddonDef, enabled: boolean): void {
    const sw = new Switch({
      label: `Enable ${addon.name}`,
      checked: enabled,
      onChange: (checked) => this.handleToggle(addon, checked),
    });

    const mountPoint = this.container.querySelector(`#${addon.settingsContainerId}`) as HTMLElement;
    if (mountPoint) {
      mountPoint.innerHTML = `
        <p class="addons-panel__description">${addon.description}</p>
        ${sw.render()}
      `;
      sw.setupEventListeners(mountPoint);
    }
    this.switches.set(addon.id, sw);
  }

  private bindContentVisibility(): void {
    const eventBus = EventBus.getInstance();
    for (const addon of ADDONS) {
      if (!addon.toggleEvent) continue;
      const contentEl = this.container.querySelector(`[data-addon-content="${addon.id}"]`) as HTMLElement;
      if (!contentEl) continue;

      eventBus.on(addon.toggleEvent, (data: { enabled: boolean }) => {
        contentEl.style.display = data.enabled ? '' : 'none';
      });
    }
  }

  private async handleToggle(addon: AddonDef, checked: boolean): Promise<void> {
    await addon.setEnabled(checked);
    const contentEl = this.container.querySelector(`[data-addon-content="${addon.id}"]`) as HTMLElement;
    if (contentEl) contentEl.style.display = checked ? '' : 'none';
    if (addon.toggleEvent) {
      EventBus.getInstance().emit(addon.toggleEvent, { enabled: checked });
    }
    ToastService.show(checked ? `${addon.name} enabled` : `${addon.name} disabled`, 'success');
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.switches.forEach(sw => sw.destroy());
    this.switches.clear();
    this.mountedSettings.forEach(s => s.unmount());
    this.mountedSettings.clear();
    this.container.innerHTML = '';
  }
}
