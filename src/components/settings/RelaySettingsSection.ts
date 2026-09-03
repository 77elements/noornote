/**
 * RelaySettingsSection Component
 * Manages public and local relay configuration
 *
 * @purpose Configure Nostr relay connections (public + local relay gateway)
 * @used-by SettingsView
 *
 * Listens to 'relays:loaded' event to update UI when account changes
 *
 * Documented architecture exception: direct NostrTransport access — this is
 * the relay diagnostics UI itself (connectivity checks, test publishes to
 * user-selected relays). The whole point is talking to specific relays
 * directly. Do NOT add further direct transport calls here.
 */

import { SettingsSection } from './SettingsSection';
import {
  RelayConfig,
  type RelayInfo,
  type RelayType,
} from '../../services/RelayConfig';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { SettingsModuleApi } from '../../modules/settings/contracts';
import { AuthService } from '../../services/AuthService';
import { ModalService } from '../../services/ModalService';
import { ToastService } from '../../services/ToastService';
import { TypedEventBus } from '../../core/TypedEventBus';
import { NostrTransport } from '../../services/transport/NostrTransport';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

interface LocalRelaySettings {
  enabled: boolean;
  mode: 'test' | 'proxy';
  url: string;
}

export class RelaySettingsSection extends SettingsSection {
  private relayConfig: RelayConfig;
  private _settingsApi: SettingsModuleApi | null = null;
  private get settingsApi(): SettingsModuleApi | null {
    if (!this._settingsApi) {
      this._settingsApi =
        ModuleLoader.getInstance().getApi<SettingsModuleApi>('settings');
    }
    return this._settingsApi;
  }
  private authService: AuthService;
  private modalService: ModalService;
  private eventBus: TypedEventBus;
  private eventBusSubscriptions: string[] = [];
  private localRelaySettings: LocalRelaySettings;
  private tempRelays: RelayInfo[];
  private readonly localRelayStorageKey = 'noornote_local_relay';

  constructor() {
    super('relay-settings');
    this.relayConfig = RelayConfig.getInstance();
    // settingsApi resolved lazily via getter
    this.authService = AuthService.getInstance();
    this.modalService = ModalService.getInstance();
    this.eventBus = TypedEventBus.getInstance();

    // Load settings
    this.localRelaySettings = this.loadLocalRelaySettings();
    this.tempRelays = this.loadRelaysFromConfig();

    // Setup listeners
    this.setupHealthUpdateListener();
    this.setupRelaysLoadedListener();
  }

  /**
   * Setup listener for relay health updates
   */
  private setupHealthUpdateListener(): void {
    this.eventBusSubscriptions.push(
      this.eventBus.on('relay:health:updated', () => {
        this.updateHealthIndicators();
      })
    );
  }

  /**
   * Setup listener for relays:loaded event (account switch)
   * Re-loads tempRelays and re-renders UI when relays are loaded
   */
  private setupRelaysLoadedListener(): void {
    this.eventBusSubscriptions.push(
      this.eventBus.on('relays:loaded', () => {
        this.tempRelays = this.loadRelaysFromConfig();
        // Re-render if section is currently mounted
        const contentContainer = document.getElementById(
          'relay-settings-content'
        );
        if (contentContainer) {
          contentContainer.innerHTML = this.renderContent();
          this.bindListeners(contentContainer as HTMLElement);
          void this.updateHealthSummary();
        }
      })
    );
  }

  /**
   * Update health indicators in the UI
   */
  private updateHealthIndicators(): void {
    const relayItems = document.querySelectorAll('.relay-item');
    relayItems.forEach(item => {
      const url = (item as HTMLElement).dataset.url;
      if (!url) return;

      const metrics = this.settingsApi?.getRelayHealthMetrics(url);
      const indicator = item.querySelector('.relay-health-indicator');

      if (indicator && metrics) {
        indicator.className = `relay-health-indicator ${metrics.isConnected ? 'connected' : 'disconnected'}`;
      }
    });

    void this.updateHealthSummary();
  }

  /**
   * Update health summary section
   */
  private async updateHealthSummary(): Promise<void> {
    const summaryContainer = document.querySelector('#relay-health-summary');
    if (!summaryContainer) return;

    const summary = (await this.settingsApi?.getHealthSummary()) ?? {
      healthy: 0,
      total: 0,
      warnings: [],
    };
    summaryContainer.innerHTML = this.renderHealthSummary(summary);
  }

  /**
   * Load local relay settings from storage
   */
  private loadLocalRelaySettings(): LocalRelaySettings {
    try {
      const stored = localStorage.getItem(this.localRelayStorageKey);
      if (stored) {
        return JSON.parse(stored) as LocalRelaySettings;
      }
    } catch (error) {
      console.debug('Failed to load local relay settings:', error);
    }

    return {
      enabled: false,
      mode: 'test',
      url: 'ws://localhost:4869',
    };
  }

  /**
   * Save local relay settings to storage
   */
  private saveLocalRelaySettings(): void {
    try {
      localStorage.setItem(
        this.localRelayStorageKey,
        JSON.stringify(this.localRelaySettings)
      );
    } catch (error) {
      console.debug('Failed to save local relay settings:', error);
    }
  }

  /**
   * Load relays from RelayConfig (per-account via PerAccountLocalStorage)
   * Excludes localhost relays (handled separately)
   */
  private loadRelaysFromConfig(): RelayInfo[] {
    return this.relayConfig
      .getAllRelays()
      .filter(r => !r.url.includes('localhost'));
  }

  /**
   * Mount section content into the DOM
   */
  public async mount(parentContainer: HTMLElement): Promise<void> {
    const contentContainer = this.getContentContainer(parentContainer);
    if (!contentContainer) return;

    // Reload temp state to ensure we have latest relays
    this.tempRelays = this.loadRelaysFromConfig();

    contentContainer.innerHTML = this.renderContent();
    this.bindListeners(contentContainer);

    // Load health summary async
    await this.updateHealthSummary();
  }

  /**
   * Render relay settings content
   */
  private renderContent(): string {
    return `
        <section class="section">
          <div class="relay-health-summary" id="relay-health-summary">
            <div class="health-summary-loading">Loading relay health status...</div>
          </div>
        </section>

        <section class="section">
          <div class="relay-add-form">
            <input
              type="text"
              class="input"
              placeholder="wss://relay.example.com"
              id="new-relay-url"
            />
            <button class="btn btn--medium" id="add-relay-btn">Add Relay</button>
          </div>

          <p class="form__note">
            Your relays are your sovereignty surface. <strong>Read</strong> = where NoorNote
            looks for content, <strong>Write</strong> = where your own events are stored,
            <strong>DM Inbox</strong> = where others can reach you with NIP-17 messages.
            When switching to a smaller (or fully private) write-set, publish the new
            relay list <em>first</em>, then disable the old relays — otherwise other
            clients can't follow the move. NoorNote automatically rebroadcasts your
            profile and follow-list to any newly-added write-relay.
          </p>

          <div class="relay-list">
            ${this.tempRelays.map(relay => this.renderRelayItem(relay)).join('')}
          </div>
        </section>
    `;
  }

  /**
   * Render health summary section
   */
  private renderHealthSummary(summary: {
    healthy: number;
    total: number;
    warnings: string[];
  }): string {
    if (summary.total === 0) {
      return '<div class="health-summary-empty">No relays configured</div>';
    }

    const healthPercentage = Math.round(
      (summary.healthy / summary.total) * 100
    );
    const healthClass =
      healthPercentage >= 80
        ? 'good'
        : healthPercentage >= 50
          ? 'warning'
          : 'critical';

    return `
      <div class="health-summary-status">
        <span class="badge badge--${healthClass === 'good' ? 'green' : healthClass === 'warning' ? 'warning' : 'danger'}">
          ${summary.healthy}/${summary.total} relays healthy (${healthPercentage}%)
        </span>
      </div>
      ${
        summary.warnings.length > 0
          ? `
        <div class="health-summary-warnings">
          ${summary.warnings
            .map(
              warning => `
            <div class="health-warning">⚠️ ${warning}</div>
          `
            )
            .join('')}
        </div>
      `
          : ''
      }
    `;
  }

  /**
   * Render single relay item
   */
  private renderRelayItem(relay: RelayInfo): string {
    const metrics = this.settingsApi?.getRelayHealthMetrics(relay.url);
    const isConnected = metrics?.isConnected ?? false;
    const latency = metrics?.latency;

    return `
      <div class="relay-item" data-url="${relay.url}">
        <div class="relay-info">
          <span class="relay-health-indicator ${isConnected ? 'connected' : 'disconnected'}"></span>
          <div class="relay-url">
            ${relay.url}
            ${latency !== null ? `<span class="relay-latency">${latency}ms</span>` : ''}
          </div>
        </div>

        <div class="relay-controls">
          <div class="relay-types">
            <button
              class="btn ${relay.types.includes('read') ? '' : 'btn--passive'}"
              data-type="read"
              data-url="${relay.url}"
            >
              Read
            </button>
            <button
              class="btn ${relay.types.includes('write') ? '' : 'btn--passive'}"
              data-type="write"
              data-url="${relay.url}"
            >
              Write
            </button>
            <button
              class="btn ${relay.types.includes('inbox') ? '' : 'btn--passive'}"
              data-type="inbox"
              data-url="${relay.url}"
            >
              DM Inbox
            </button>
          </div>

          <button class="relay-remove-btn" data-url="${relay.url}" aria-label="Remove relay">
            <svg width="18" height="18"><use href="#icon-delete-extended"/></svg>
          </button>
        </div>
      </div>
    `;
  }

  /**
   * Bind event listeners
   */
  private bindListeners(contentContainer: HTMLElement): void {
    // Add relay button
    const addBtn = contentContainer.querySelector('#add-relay-btn');
    addBtn?.addEventListener('click', () =>
      this.handleAddRelay(contentContainer)
    );

    // Add relay on Enter key
    const input = contentContainer.querySelector(
      '#new-relay-url'
    ) as HTMLInputElement;
    input?.addEventListener('keypress', e => {
      if (e.key === 'Enter') void this.handleAddRelay(contentContainer);
    });

    // Relay type toggle buttons
    const typeButtons = contentContainer.querySelectorAll('.relay-types .btn');
    typeButtons.forEach(btn => {
      btn.addEventListener('click', e => this.handleToggleRelayType(e));
    });

    // Remove relay buttons
    const removeButtons =
      contentContainer.querySelectorAll('.relay-remove-btn');
    removeButtons.forEach(btn => {
      btn.addEventListener('click', e =>
        this.handleRemoveRelay(e, contentContainer)
      );
    });
  }

  /**
   * Handle add new relay
   */
  private async handleAddRelay(contentContainer: HTMLElement): Promise<void> {
    const input = contentContainer.querySelector(
      '#new-relay-url'
    ) as HTMLInputElement;
    let url = input?.value.trim();

    if (!url) return;

    if (!url.startsWith('wss://') && !url.startsWith('ws://')) {
      ToastService.show('Relay URL must start with wss:// or ws://', 'error');
      return;
    }

    url = url.replace(/\/$/, '');

    const normalizedExisting = this.tempRelays.map(r =>
      r.url.replace(/\/$/, '')
    );
    if (normalizedExisting.includes(url)) {
      ToastService.show('This relay is already in your list', 'error');
      return;
    }

    this.tempRelays.push({
      url,
      types: ['read', 'write'],
      isPaid: false,
      requiresAuth: false,
      isActive: true,
    });

    input.value = '';
    contentContainer.innerHTML = this.renderContent();
    this.bindListeners(contentContainer);

    await this.saveAndPublish();
  }

  /**
   * Handle toggle relay type
   */
  private async handleToggleRelayType(e: Event): Promise<void> {
    const btn = e.currentTarget as HTMLElement;
    const url = btn.dataset.url;
    const type = btn.dataset.type as RelayType;

    const relay = url && type ? this.tempRelays.find(r => r.url === url) : null;
    if (!relay) return;

    if (relay.types.includes(type)) {
      relay.types = relay.types.filter(t => t !== type);
      btn.classList.add('btn--passive');
    } else {
      relay.types.push(type);
      btn.classList.remove('btn--passive');
    }

    await this.saveAndPublish();
  }

  /**
   * Handle remove relay
   */
  private handleRemoveRelay(e: Event, contentContainer: HTMLElement): void {
    const btn = e.currentTarget as HTMLElement;
    const url = btn.dataset.url;

    if (!url) return;

    this.modalService.show({
      title: 'Remove Relay',
      content: `
        <div style="padding: 1rem 0;">
          <p>Are you sure you want to remove this relay?</p>
          <p style="margin-top: 0.5rem; color: var(--color-text-secondary); font-size: 0.9rem;">
            <strong>${url}</strong>
          </p>
        </div>
        <div style="display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1.5rem;">
          <button class="btn" data-action="cancel">Cancel</button>
          <button class="btn btn--danger" data-action="confirm">Remove</button>
        </div>
      `,
      width: '500px',
      showCloseButton: true,
      closeOnOverlay: true,
      closeOnEsc: true,
    });

    setTimeout(() => {
      const cancelBtn = document.querySelector('[data-action="cancel"]');
      const confirmBtn = document.querySelector('[data-action="confirm"]');

      cancelBtn?.addEventListener('click', () => {
        this.modalService.hide();
      });

      confirmBtn?.addEventListener('click', async () => {
        this.tempRelays = this.tempRelays.filter(r => r.url !== url);
        this.modalService.hide();
        contentContainer.innerHTML = this.renderContent();
        this.bindListeners(contentContainer);

        await this.saveAndPublish();
      });
    }, 0);
  }

  /**
   * Save relay configuration and publish to network
   */
  private async saveAndPublish(): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      ToastService.show('Please log in to save relay settings', 'error');
      return;
    }

    // Validate the relay set is usable. Allowing all-inbox / all-read /
    // all-write configurations would break the app in subtle ways:
    // without a read-relay the timeline can't populate, without a
    // write-relay the user can publish nothing. Local-relay mode is
    // exempt because the local relay implicitly carries both roles.
    if (!this.localRelaySettings.enabled) {
      const hasRead = this.tempRelays.some(r => r.types.includes('read'));
      const hasWrite = this.tempRelays.some(r => r.types.includes('write'));
      if (!hasRead || !hasWrite) {
        ToastService.show(
          'You need at least one read-relay and one write-relay configured.',
          'error'
        );
        return;
      }
    }

    // Snapshot the OLD write-relays before mutating RelayConfig so we can
    // diff against the new set after save and republish account-essential
    // events (kind:0 / kind:3) to newly-added relays. Without this a fresh
    // write-relay (e.g. the user's private relay they just configured)
    // starts empty — visitors hitting only that relay would see no
    // profile, no follow-list, no inbox-list until the user touches each.
    // Amethyst's `republishEventsTo(accountSettingsEvents(), newOutbox)`
    // pattern (see docs/todos/private-relay-sovereignty.md §3.6a).
    const previousWriteRelays = new Set(this.relayConfig.getWriteRelays());

    // Fetch kind:0 + kind:3 NOW, before the RelayConfig mutation, so the
    // source set is the user's PREVIOUS read+write relays (where their
    // events actually live). After the mutation `getReadRelays()` would
    // point at the new — possibly single, possibly empty — relay set and
    // the fetch would find nothing. We hold the events in memory and
    // publish them post-save to the newly-added write-relays only.
    const accountEssentialsPromise = this.fetchAccountEssentials(
      currentUser.pubkey
    );

    try {
      // Save local relay settings
      this.saveLocalRelaySettings();

      // Clear all existing relays from RelayConfig
      const existingRelays = this.relayConfig.getAllRelays();
      existingRelays.forEach(relay => {
        this.relayConfig.removeRelay(relay.url);
      });

      // Add relays to RelayConfig (saves to per-account cache automatically)
      if (this.localRelaySettings.enabled) {
        // Local relay mode: Read from public, write to local
        this.tempRelays.forEach(relay => {
          this.relayConfig.addRelay({
            ...relay,
            types: ['read'],
          });
        });

        this.relayConfig.addRelay({
          url: this.localRelaySettings.url,
          name: 'Local Relay',
          types: ['write', 'inbox'],
          isPaid: false,
          requiresAuth: false,
          isActive: true,
        });
      } else {
        // Direct mode: Use public relays normally
        this.tempRelays.forEach(relay => {
          this.relayConfig.addRelay(relay);
        });
      }

      // Publish NIP-65 relay list (kind:10002) to network
      await this.publishRelayList();

      // Publish NIP-17 DM relay list (kind:10050) to network
      await this.publishDMRelayList();

      // Republish account-essential events (kind:0 profile, kind:3 follow
      // list) to any newly-added write-relays so they're not empty when
      // other clients query them. Fire-and-forget — failure here is a
      // soft warning, not a save-blocker. The events were fetched from
      // the PREVIOUS relay set above, so the source data exists even when
      // the user reduces to a single brand-new private relay.
      const newlyAdded = this.relayConfig
        .getWriteRelays()
        .filter(url => !previousWriteRelays.has(url));
      if (newlyAdded.length > 0) {
        void accountEssentialsPromise
          .then(events => this.publishEventsTo(events, newlyAdded))
          .catch(err => {
            console.debug(
              '[RelaySettings] republish to new write-relays failed',
              err
            );
          });
      }

      ToastService.show('Relay settings saved', 'success');
    } catch (error) {
      ToastService.show('Failed to save relay settings', 'error');
      console.error('[RelaySettings] Save error:', error);
    }
  }

  /**
   * Get current user and write relays for publishing, or null if unavailable
   */
  private getPublishContext(): {
    user: { npub: string; pubkey: string };
    writeRelays: string[];
  } | null {
    const user = this.authService.getCurrentUser();
    if (!user) {
      console.debug('No user logged in, skipping publish');
      return null;
    }

    const writeRelays = this.relayConfig.getWriteRelays();
    if (writeRelays.length === 0) {
      console.debug('No write relays available for publishing');
      return null;
    }

    return { user, writeRelays };
  }

  /**
   * Publish relay list to network as NIP-65 (kind:10002)
   */
  private async publishRelayList(): Promise<void> {
    const context = this.getPublishContext();
    if (!context) return;

    try {
      const relayTags =
        this.settingsApi?.relayInfosToTags(this.tempRelays) ?? [];
      const unsignedEvent = {
        kind: 10002,
        created_at: Math.floor(Date.now() / 1000),
        tags: relayTags,
        content: '',
        pubkey: context.user.pubkey,
      };

      const signedEvent = await this.authService.signEvent(unsignedEvent);

      // Orchestrator emits via `publishEverywhere` so the NIP-65 lands on
      // write + read + aggregator + indexer relays — required for the
      // bootstrap path when the user moves to a smaller write-set.
      await this.settingsApi?.publishRelayList(this.tempRelays, signedEvent);

      console.debug('[RelaySettings] Relay list published successfully');
    } catch (error) {
      console.error('Failed to publish relay list:', error);
      throw error;
    }
  }

  /**
   * Publish DM relay list to network as NIP-17 (kind:10050)
   */
  private async publishDMRelayList(): Promise<void> {
    const context = this.getPublishContext();
    if (!context) return;

    const inboxRelays = this.tempRelays.filter(r => r.types.includes('inbox'));
    if (inboxRelays.length === 0) {
      console.debug(
        '[RelaySettings] No DM inbox relays configured, skipping kind:10050 publish'
      );
      return;
    }

    try {
      const relayTags = inboxRelays.map(r => ['relay', r.url]);
      const unsignedEvent = {
        kind: 10050,
        created_at: Math.floor(Date.now() / 1000),
        tags: relayTags,
        content: '',
        pubkey: context.user.pubkey,
      };

      const signedEvent = await this.authService.signEvent(unsignedEvent);

      // kind:10050 is discovery metadata — broadcast everywhere so other
      // clients can find this user's NIP-17 inbox-set regardless of which
      // relays they happen to query.
      const transport = NostrTransport.getInstance();
      await transport.publishEverywhere(signedEvent);

      console.debug(
        `[RelaySettings] DM relay list published (${inboxRelays.length} relays)`
      );
    } catch (error) {
      console.error('Failed to publish DM relay list:', error);
    }
  }

  /**
   * Fetch the user's latest kind:0 (profile) and kind:3 (follow list)
   * from the CURRENT relay set. Used during `saveAndPublish` to seed
   * the to-be-republished events BEFORE the RelayConfig mutation —
   * after the mutation `getReadRelays()` would point at the new
   * (possibly empty) relay set and the fetch would find nothing.
   *
   * Combines the current write and read relays as source — both are
   * places the user's own kind:0/3 might be stored after a prior
   * publish. A best-effort fetch: failure returns an empty array so
   * the caller publishes what it has (possibly nothing).
   */
  private async fetchAccountEssentials(pubkey: string): Promise<NostrEvent[]> {
    const transport = NostrTransport.getInstance();
    const sourceRelays = [
      ...new Set<string>([
        ...this.relayConfig.getWriteRelays(),
        ...this.relayConfig.getReadRelays(),
      ]),
    ];
    if (sourceRelays.length === 0) return [];
    try {
      return await transport.fetch(
        sourceRelays,
        [
          {
            authors: [pubkey],
            kinds: [0, 3],
            limit: 2,
          },
        ],
        5000,
        false,
        'RelaySettingsRepublish'
      );
    } catch (err) {
      console.debug('[RelaySettings] account-essentials fetch failed', err);
      return [];
    }
  }

  /**
   * Publish each event to the given relay set. Failures per event are
   * logged but don't abort the rest — partial republish is better than
   * none.
   */
  private async publishEventsTo(
    events: NostrEvent[],
    targetRelays: string[]
  ): Promise<void> {
    if (events.length === 0 || targetRelays.length === 0) return;
    const transport = NostrTransport.getInstance();
    for (const event of events) {
      try {
        await transport.publish(targetRelays, event);
      } catch (err) {
        console.debug(
          `[RelaySettings] republish kind:${event.kind} failed`,
          err
        );
      }
    }
    console.debug(
      `[RelaySettings] republished ${events.length} account-essential events to ${targetRelays.length} new relay(s)`
    );
  }

  /**
   * Unmount section and cleanup
   */
  public unmount(): void {
    this.eventBusSubscriptions.forEach(id => this.eventBus.off(id));
    this.eventBusSubscriptions = [];
  }
}
