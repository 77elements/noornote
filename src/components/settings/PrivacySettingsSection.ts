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
import { _ } from '../../i18n';
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
        title: _('Follow Lists'),
        listName: _('follow lists'),
        switchLabel: _('Use private follow lists (NIP-51)'),
        description: _(
          'Private follow lists (NIP-51) allow you to follow users without publicly revealing who you follow. Your follow list is encrypted and only you can see it.'
        ),
        viewButtonLabel: _('View Follows'),
        isEnabled: () => this.followListOrch.isPrivateFollowsEnabled(),
        setEnabled: enabled =>
          this.followListOrch.setPrivateFollowsEnabled(enabled),
      },
      ...(isBookmarksEnabled()
        ? [
            {
              id: 'bookmarks' as const,
              title: _('Bookmark List'),
              listName: _('bookmarks'),
              switchLabel: _('Use private bookmarks (NIP-51)'),
              description: _(
                'Private bookmarks (NIP-51) allow you to bookmark notes without publicly revealing what you bookmarked. Your bookmarks are encrypted and only you can see them.'
              ),
              viewButtonLabel: _('View Bookmarks'),
              isEnabled: () => this.bookmarkOrch.isPrivateBookmarksEnabled(),
              setEnabled: (enabled: boolean) =>
                this.bookmarkOrch.setPrivateBookmarksEnabled(enabled),
            },
          ]
        : []),
      {
        id: 'mutes',
        title: _('Mute List'),
        listName: _('mutes'),
        switchLabel: _('Use private mutes (NIP-51)'),
        description: _(
          'Private mutes (NIP-51) allow you to mute users without publicly revealing who you muted. Your mute list is encrypted and only you can see it.'
        ),
        viewButtonLabel: _('View Muted Users'),
        isEnabled: () => this.muteOrch.isPrivateMutesEnabled(),
        setEnabled: enabled => this.muteOrch.setPrivateMutesEnabled(enabled),
      },
      {
        id: 'petnames',
        title: _('Private Petnames'),
        listName: _('petnames'),
        switchLabel: _('Private petnames'),
        description: _(
          'Adds a note icon next to each profile where you can store an encrypted, private note about that user (NIP-78). Notes are NIP-44 self-encrypted — only you can read them, and they are never published unencrypted. This is separate from public petnames, which live in your contact list and are visible to everyone.'
        ),
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
        : `<p class="setting__desc ${config.id}-warning"><strong>${_('Beta Feature:')}</strong> ${_("Not all Nostr clients support NIP-51 yet. If you use other clients that don't support NIP-51, you won't be able to see your private %s.", config.listName)}</p>`;
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
          checked
            ? _('Private %s enabled', config.listName)
            : _('Private %s disabled', config.listName),
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
          _('Encryption method set to %s', method.toUpperCase()),
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
      ToastService.show(_('Please log in to migrate follow lists'), 'error');
      return;
    }

    const isToPrivate = direction === 'private';
    const title = isToPrivate
      ? _('Move Follows to Private List')
      : _('Move Follows to Public List');
    const warning = isToPrivate
      ? _(
          'This operation is irreversible without using the reverse migration tool.'
        )
      : _('Everyone will be able to see who you follow after this operation.');

    this.modalService.show({
      title,
      content: `
        <div style="padding: 1rem 0;">
          <p>${_('This will:')}</p>
          <ul style="margin: 1rem 0; padding-left: 1.5rem;">
            <li>${isToPrivate ? _('Encrypt all your current public follows (kind:3)') : _('Decrypt all your current private follows (kind:30000)')}</li>
            <li>${isToPrivate ? _('Store them in a private follow list (kind:30000)') : _('Store them in a public follow list (kind:3)')}</li>
            <li>${isToPrivate ? _('Clear your public follow list') : _('Clear your private follow list')}</li>
          </ul>
          <p><strong>${_('Warning:')}</strong> ${warning}</p>
        </div>
        <div style="display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1.5rem;">
          <button class="btn" data-action="cancel">${_('Cancel')}</button>
          <button class="btn" data-action="confirm">${_('Migrate')}</button>
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
            const message = isToPrivate
              ? _('Follows migrated to private list')
              : _('Follows migrated to public list');

            ToastService.show(
              success ? message : _('Migration failed'),
              success ? 'success' : 'error'
            );
          } catch (error) {
            ToastService.show(_('Migration error: %s', String(error)), 'error');
          }
        });
    }, 0);
  }

  public unmount(): void {
    this.switches.clear();
  }
}
