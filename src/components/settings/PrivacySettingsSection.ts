/**
 * PrivacySettingsSection Component
 * Manages NIP-51 privacy settings (Follow Lists, Bookmarks, Tribes, Mutes)
 *
 * @purpose Configure private lists using NIP-51 encryption
 * @used-by SettingsView
 */

import { SettingsSection } from './SettingsSection';
import { FollowListOrchestrator } from '../../lists/follows';
import { BookmarkOrchestrator } from '../../lists/bookmarks';
import { MuteOrchestrator } from '../../lists/mutes';
import { isBookmarksEnabled } from '../../addons/bookmarks/index';
import { PetnameService } from '../../services/PetnameService';
import { AuthService } from '../../services/AuthService';
import { ModalService } from '../../services/ModalService';
import { ToastService } from '../../services/ToastService';
import { Switch } from '../ui/Switch';
import { TypedEventBus } from '../../core/TypedEventBus';
type ListType = 'follows' | 'bookmarks' | 'mutes' | 'petnames';

interface PrivacySectionConfig {
  id: ListType;
  title: string;
  listName: string;
  switchLabel: string;
  description: string;
  viewButtonLabel?: string; // omit to hide the "View …" button (e.g. petnames have no list view)
  betaWarning?: boolean; // default true; set false for non-NIP-51 features (petnames are NIP-78)
  isEnabled: () => boolean;
  setEnabled: (enabled: boolean) => void;
}

export class PrivacySettingsSection extends SettingsSection {
  private followListOrch: ReturnType<typeof FollowListOrchestrator.getInstance>;
  private bookmarkOrch: ReturnType<typeof BookmarkOrchestrator.getInstance>;
  private muteOrch: ReturnType<typeof MuteOrchestrator.getInstance>;
  private petnameService: PetnameService;
  private authService: AuthService;
  private modalService: ModalService;
  private switches: Map<ListType, Switch> = new Map();

  constructor() {
    super('privacy-settings');
    this.followListOrch = FollowListOrchestrator.getInstance();
    this.bookmarkOrch = BookmarkOrchestrator.getInstance();
    this.muteOrch = MuteOrchestrator.getInstance();
    this.petnameService = PetnameService.getInstance();
    this.authService = AuthService.getInstance();
    this.modalService = ModalService.getInstance();
  }

  public mount(parentContainer: HTMLElement): void {
    const contentContainer = this.getContentContainer(parentContainer);
    if (!contentContainer) return;

    contentContainer.innerHTML = this.renderContent();
    this.bindListeners(contentContainer);
  }

  private getSectionConfigs(): PrivacySectionConfig[] {
    return [
      {
        id: 'follows',
        title: 'Follow Lists',
        listName: 'follow lists',
        switchLabel: 'Use private follow lists (NIP-51)',
        description:
          'Private follow lists (NIP-51) allow you to follow users without publicly revealing who you follow. Your follow list is encrypted and only you can see it.',
        viewButtonLabel: 'View Follows',
        isEnabled: () => this.followListOrch.isPrivateFollowsEnabled(),
        setEnabled: enabled =>
          this.followListOrch.setPrivateFollowsEnabled(enabled),
      },
      ...(isBookmarksEnabled()
        ? [
            {
              id: 'bookmarks' as const,
              title: 'Bookmark List',
              listName: 'bookmarks',
              switchLabel: 'Use private bookmarks (NIP-51)',
              description:
                'Private bookmarks (NIP-51) allow you to bookmark notes without publicly revealing what you bookmarked. Your bookmarks are encrypted and only you can see them.',
              viewButtonLabel: 'View Bookmarks',
              isEnabled: () => this.bookmarkOrch.isPrivateBookmarksEnabled(),
              setEnabled: (enabled: boolean) =>
                this.bookmarkOrch.setPrivateBookmarksEnabled(enabled),
            },
          ]
        : []),
      {
        id: 'mutes',
        title: 'Mute List',
        listName: 'mutes',
        switchLabel: 'Use private mutes (NIP-51)',
        description:
          'Private mutes (NIP-51) allow you to mute users without publicly revealing who you muted. Your mute list is encrypted and only you can see it.',
        viewButtonLabel: 'View Muted Users',
        isEnabled: () => this.muteOrch.isPrivateMutesEnabled(),
        setEnabled: enabled => this.muteOrch.setPrivateMutesEnabled(enabled),
      },
      {
        id: 'petnames',
        title: 'Private Petnames',
        listName: 'petnames',
        switchLabel: 'Private petnames',
        description:
          'Adds a note icon next to each profile where you can store an encrypted, private note about that user (NIP-78). Notes are NIP-44 self-encrypted — only you can read them, and they are never published unencrypted. This is separate from public petnames, which live in your contact list and are visible to everyone.',
        betaWarning: false,
        isEnabled: () => this.petnameService.isPrivateNotesEnabled(),
        setEnabled: enabled =>
          this.petnameService.setPrivateNotesEnabled(enabled),
      },
    ];
  }

  private renderContent(): string {
    const sections = this.getSectionConfigs()
      .map(config => this.renderPrivacySubsection(config))
      .join('');

    return sections;
  }

  private renderPrivacySubsection(config: PrivacySectionConfig): string {
    const warning =
      config.betaWarning === false
        ? ''
        : `<p class="setting__desc ${config.id}-warning"><strong>Beta Feature:</strong> Not all Nostr clients support NIP-51 yet. If you use other clients that don't support NIP-51, you won't be able to see your private ${config.listName}.</p>`;
    const viewButton = config.viewButtonLabel
      ? `<div class="l-row l-row--right">
          <button class="btn btn--medium" id="view-${config.id}-btn">${config.viewButtonLabel}</button>
        </div>`
      : '';
    return `
      <section class="section">
        <div class="setting">
          <span class="setting__label">${config.switchLabel}</span>
          <div class="setting__control" id="private-${config.id}-switch-container"></div>
          <p class="setting__desc">${config.description}</p>
          ${warning}
        </div>
        ${viewButton}
      </section>
    `;
  }

  private bindListeners(contentContainer: HTMLElement): void {
    for (const config of this.getSectionConfigs()) {
      this.bindSectionListeners(contentContainer, config);
    }

    this.bindFollowsMigrationListeners(contentContainer);
    this.bindMutesEncryptionListeners(contentContainer);
  }

  private bindSectionListeners(
    contentContainer: HTMLElement,
    config: PrivacySectionConfig
  ): void {
    const switchContainer = contentContainer.querySelector(
      `#private-${config.id}-switch-container`
    );
    if (!switchContainer) return;

    const switchComponent = new Switch({
      label: '',
      checked: config.isEnabled(),
      onChange: checked => {
        config.setEnabled(checked);
        this.handleSectionToggle(contentContainer, config.id, checked);
        ToastService.show(
          `Private ${config.listName} ${checked ? 'enabled' : 'disabled'}`,
          'success'
        );
      },
    });

    this.switches.set(config.id, switchComponent);
    switchContainer.innerHTML = switchComponent.render();
    switchComponent.setupEventListeners(switchContainer as HTMLElement);

    const viewBtn = contentContainer.querySelector(`#view-${config.id}-btn`);
    viewBtn?.addEventListener('click', () => {
      TypedEventBus.getInstance().emit('list:open', { listType: config.id });
    });
  }

  private handleSectionToggle(
    contentContainer: HTMLElement,
    sectionId: ListType,
    enabled: boolean
  ): void {
    if (sectionId === 'follows') {
      contentContainer
        .querySelector('#migration-section')
        ?.classList.toggle('hidden', !enabled);
    } else if (sectionId === 'mutes') {
      contentContainer
        .querySelector('#mutes-encryption-method')
        ?.classList.toggle('hidden', !enabled);
    }
  }

  private bindFollowsMigrationListeners(contentContainer: HTMLElement): void {
    contentContainer
      .querySelector('#migrate-to-private-btn')
      ?.addEventListener('click', () => this.handleMigration('private'));
    contentContainer
      .querySelector('#migrate-to-public-btn')
      ?.addEventListener('click', () => this.handleMigration('public'));
  }

  private bindMutesEncryptionListeners(contentContainer: HTMLElement): void {
    const encryptionRadios = contentContainer.querySelectorAll(
      'input[name="mute-encryption-method"]'
    );
    encryptionRadios.forEach(radio => {
      radio.addEventListener('change', event => {
        const target = event.target as HTMLInputElement;
        const method = target.value as 'nip04' | 'nip44';
        this.muteOrch.setEncryptionMethod(method);
        ToastService.show(
          `Encryption method set to ${method.toUpperCase()}`,
          'success'
        );
      });
    });
  }

  private async handleMigration(
    direction: 'private' | 'public'
  ): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      ToastService.show('Please log in to migrate follow lists', 'error');
      return;
    }

    const isToPrivate = direction === 'private';
    const title = isToPrivate
      ? 'Move Follows to Private List'
      : 'Move Follows to Public List';
    const warning = isToPrivate
      ? 'This operation is irreversible without using the reverse migration tool.'
      : 'Everyone will be able to see who you follow after this operation.';
    const sourceKind = isToPrivate ? 'kind:3' : 'kind:30000';
    const targetKind = isToPrivate ? 'kind:30000' : 'kind:3';
    const sourceType = isToPrivate ? 'public' : 'private';
    const targetType = isToPrivate ? 'private' : 'public';

    this.modalService.show({
      title,
      content: `
        <div style="padding: 1rem 0;">
          <p>This will:</p>
          <ul style="margin: 1rem 0; padding-left: 1.5rem;">
            <li>${isToPrivate ? 'Encrypt' : 'Decrypt'} all your current ${sourceType} follows (${sourceKind})</li>
            <li>Store them in a ${targetType} follow list (${targetKind})</li>
            <li>Clear your ${sourceType} follow list</li>
          </ul>
          <p><strong>Warning:</strong> ${warning}</p>
        </div>
        <div style="display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1.5rem;">
          <button class="btn" data-action="cancel">Cancel</button>
          <button class="btn" data-action="confirm">Migrate</button>
        </div>
      `,
      width: '500px',
      showCloseButton: true,
      closeOnOverlay: true,
      closeOnEsc: true,
    });

    setTimeout(() => {
      document
        .querySelector('[data-action="cancel"]')
        ?.addEventListener('click', () => {
          this.modalService.hide();
        });

      document
        .querySelector('[data-action="confirm"]')
        ?.addEventListener('click', async () => {
          this.modalService.hide();

          try {
            const migrateMethod = isToPrivate
              ? this.followListOrch.migrateToPrivate.bind(this.followListOrch)
              : this.followListOrch.migrateToPublic.bind(this.followListOrch);

            const success = await migrateMethod(currentUser.pubkey);
            const message = `Follows migrated to ${targetType} list`;

            ToastService.show(
              success ? message : 'Migration failed',
              success ? 'success' : 'error'
            );
          } catch (error) {
            ToastService.show(`Migration error: ${error}`, 'error');
          }
        });
    }, 0);
  }

  public unmount(): void {
    this.switches.clear();
  }
}
