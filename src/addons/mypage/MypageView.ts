/**
 * MypageView
 * Readonly display of a user's My Page (custom list + mounted bookmark folders)
 *
 * Route: /profile/:npub/page
 * Aggregates the custom list (freetext sections) and any mounted bookmark
 * folders into one personal page. Owner sees Edit + Delete buttons (apply
 * only to the custom list — folder mounts are managed via bookmarks).
 *
 * @purpose Display My Page for any user
 * @used-by ViewMountingService (route: mypage)
 */

import { View } from '../../components/views/View';
import { AuthService } from '../../services/AuthService';
import { MypageOrchestrator } from '../../services/orchestration/MypageOrchestrator';
import { MypageService, type MypageListData } from '../../services/MypageService';
import { UserProfileService } from '../../services/UserProfileService';
import { Router } from '../../services/Router';
import { ModalService } from '../../services/ModalService';
import { ToastService } from '../../services/ToastService';
import { decodeNip19 } from '../../services/NostrToolsAdapter';
import { ProfileListsComponent } from '../../components/profile/ProfileListsComponent';
import { EventBus } from '../../services/EventBus';
import DOMPurify from 'dompurify';

export class MypageView extends View {
  private container: HTMLElement;
  private npub: string;
  private pubkey: string;
  private isOwnProfile: boolean;
  private orchestrator: MypageOrchestrator;
  private listService: MypageService;
  private mountsComponent: ProfileListsComponent | null = null;
  private eventBusSubscriptions: string[] = [];

  constructor(npub: string) {
    super();
    this.npub = npub;
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--mypage';
    this.orchestrator = MypageOrchestrator.getInstance();
    this.listService = MypageService.getInstance();

    try {
      const decoded = decodeNip19(npub);
      this.pubkey = decoded.type === 'npub'
        ? decoded.data as string
        : (decoded.data as { pubkey: string }).pubkey;
    } catch {
      this.pubkey = '';
    }

    this.isOwnProfile = AuthService.getInstance().isCurrentUser(this.pubkey);

    this.setupChangeListeners();
    this.loadAndRender();
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    const eventBus = EventBus.getInstance();
    this.eventBusSubscriptions.forEach(id => eventBus.off(id));
    this.eventBusSubscriptions = [];
    this.mountsComponent?.destroy();
    this.mountsComponent = null;
    this.container.innerHTML = '';
  }

  /**
   * Live-refresh on local changes (only matters for own profile — toggles
   * happen in the bookmarks view but the user may navigate back here without
   * a full re-mount, e.g. via browser history)
   */
  private setupChangeListeners(): void {
    if (!this.isOwnProfile) return;
    const eventBus = EventBus.getInstance();
    this.eventBusSubscriptions.push(
      eventBus.on('mypageMounts:changed', () => this.loadAndRender())
    );
    this.eventBusSubscriptions.push(
      eventBus.on('mypageList:changed', () => this.loadAndRender())
    );
  }

  private async loadAndRender(): Promise<void> {
    // Clean up previous mounts component before re-rendering (innerHTML wipes
    // DOM but the JS instance lingers)
    if (this.mountsComponent) {
      this.mountsComponent.destroy();
      this.mountsComponent = null;
    }

    this.container.innerHTML = `
      <div class="mypage-loading">
        <div class="loading-spinner"></div>
        <p>Loading page...</p>
      </div>
    `;

    try {
      let listData: MypageListData | null;

      if (this.isOwnProfile) {
        listData = this.listService.getList();
        if (!listData || listData.sections.length === 0) {
          listData = await this.orchestrator.fetchFromRelays(this.pubkey, true);
          if (listData && listData.sections.length > 0) {
            this.listService.setListFromRelay(listData);
          }
        }
      } else {
        listData = await this.orchestrator.fetchFromRelays(this.pubkey, true);
      }

      const hasList = !!listData && listData.sections.length > 0;

      if (hasList) {
        await this.renderList(listData!);
      } else {
        this.renderShellWithoutList();
      }

      // Append mounted bookmark folders (if any)
      await this.renderMounts();

      // After both list and mounts are rendered, decide whether to show empty
      // state: only when neither list nor mounts produced content.
      const hasMounts = this.container.querySelectorAll('.profile-lists-mount').length > 0;
      if (!hasList && !hasMounts) {
        this.renderEmpty();
      }
    } catch (error) {
      console.error('Failed to load My Page:', error);
      this.container.innerHTML = '<p class="mypage-error">Failed to load page.</p>';
    }
  }

  private renderEmpty(): void {
    const profileName = this.isOwnProfile ? 'You' : 'This user';
    this.container.innerHTML = `
      <div class="mypage-empty">
        <p>${profileName} ${this.isOwnProfile ? "haven't" : "hasn't"} set up a page yet.</p>
        ${this.isOwnProfile ? `
          <button class="btn btn--medium btn--primary" data-action="create-page">Set up My Page</button>
        ` : ''}
      </div>
    `;

    if (this.isOwnProfile) {
      this.container.querySelector('[data-action="create-page"]')?.addEventListener('click', () => {
        Router.getInstance().navigate(`/profile/${this.npub}/page/edit`);
      });
    }
  }

  /**
   * Render header + empty list area when no custom list exists yet
   * (mounts can still be appended below by renderMounts()).
   */
  private async renderShellWithoutList(): Promise<void> {
    const username = await this.loadUsername();
    this.container.innerHTML = `
      <div class="mypage-view">
        <div class="mypage-header">
          <div class="mypage-header__left">
            <button class="btn btn--medium btn--passive" data-action="back">&larr; Back to ${DOMPurify.sanitize(username)}'s profile</button>
          </div>
          ${this.isOwnProfile ? `
            <div class="mypage-header__actions">
              <button class="btn btn--medium btn--passive" data-action="edit-list">
                <svg width="14" height="14"><use href="#icon-edit"/></svg>
                Add list
              </button>
            </div>
          ` : ''}
        </div>
      </div>
    `;
    this.bindHeaderEvents();
  }

  private async loadUsername(): Promise<string> {
    try {
      const profile = await UserProfileService.getInstance().getUserProfile(this.pubkey);
      return profile?.name || profile?.display_name || this.npub.slice(0, 12) + '...';
    } catch {
      return this.npub.slice(0, 12) + '...';
    }
  }

  private async renderList(data: MypageListData): Promise<void> {
    const username = await this.loadUsername();

    const sectionsHtml = data.sections.map(section => `
      <div class="mypage-section">
        <h2 class="mypage-section__title">${DOMPurify.sanitize(section.title)}</h2>
        <ul class="mypage-section__items">
          ${section.items.map(item => `
            <li class="mypage-section__item">${DOMPurify.sanitize(item)}</li>
          `).join('')}
        </ul>
      </div>
    `).join('');

    this.container.innerHTML = `
      <div class="mypage-view">
        <div class="mypage-header">
          <div class="mypage-header__left">
            <button class="btn btn--medium btn--passive" data-action="back">&larr; Back to ${DOMPurify.sanitize(username)}'s profile</button>
          </div>
          ${this.isOwnProfile ? `
            <div class="mypage-header__actions">
              <button class="btn btn--medium btn--passive" data-action="edit-list">
                <svg width="14" height="14"><use href="#icon-edit"/></svg>
                Edit
              </button>
              <button class="btn btn--medium btn--danger" data-action="delete-list">Delete</button>
            </div>
          ` : ''}
        </div>
        ${sectionsHtml}
      </div>
    `;

    this.bindHeaderEvents();
  }

  private async renderMounts(): Promise<void> {
    const view = this.container.querySelector('.mypage-view');
    if (!view) return;

    // Anchor mounts to the last child of the view so they appear after the list
    const lastChild = view.lastElementChild;
    if (!lastChild) return;

    this.mountsComponent = new ProfileListsComponent(this.pubkey, 'mypage');
    await this.mountsComponent.render(lastChild);
  }

  private bindHeaderEvents(): void {
    this.container.querySelector('[data-action="edit-list"]')?.addEventListener('click', () => {
      Router.getInstance().navigate(`/profile/${this.npub}/page/edit`);
    });

    this.container.querySelector('[data-action="delete-list"]')?.addEventListener('click', async () => {
      const confirmed = await ModalService.getInstance().confirm({
        title: 'Delete List',
        message: 'This will delete the custom list portion of your page from all relays. Mounted bookmark folders are not affected. This cannot be undone.',
        confirmDestructive: true,
      });
      if (!confirmed) return;

      try {
        this.listService.deleteList();
        await this.orchestrator.deleteFromRelays();
        ToastService.show('List deleted', 'success');
        Router.getInstance().navigate(`/profile/${this.npub}`);
      } catch (error) {
        console.error('Failed to delete list:', error);
        ToastService.show('Failed to delete list', 'error');
      }
    });

    this.container.querySelector('[data-action="back"]')?.addEventListener('click', (e) => {
      e.preventDefault();
      Router.getInstance().navigate(`/profile/${this.npub}`);
    });
  }
}
