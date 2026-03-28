/**
 * NostrInListView
 * Readonly display of a user's professional list (NostrIn addon)
 *
 * Route: /profile/:npub/list
 * Shows freetext sections with items. Owner sees Edit + Delete buttons.
 *
 * @purpose Display professional list for any user
 * @used-by ViewMountingService (route: nostrin-list)
 */

import { View } from '../../components/views/View';
import { AuthService } from '../../services/AuthService';
import { NostrInListOrchestrator } from '../../services/orchestration/NostrInListOrchestrator';
import { NostrInListService, type NostrInListData } from '../../services/NostrInListService';
import { UserProfileService } from '../../services/UserProfileService';
import { Router } from '../../services/Router';
import { ModalService } from '../../services/ModalService';
import { ToastService } from '../../services/ToastService';
import { decodeNip19 } from '../../services/NostrToolsAdapter';
import DOMPurify from 'dompurify';

export class NostrInListView extends View {
  private container: HTMLElement;
  private npub: string;
  private pubkey: string;
  private isOwnProfile: boolean;
  private orchestrator: NostrInListOrchestrator;
  private listService: NostrInListService;

  constructor(npub: string) {
    super();
    this.npub = npub;
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--nostrin-list';
    this.orchestrator = NostrInListOrchestrator.getInstance();
    this.listService = NostrInListService.getInstance();

    try {
      const decoded = decodeNip19(npub);
      this.pubkey = decoded.type === 'npub'
        ? decoded.data as string
        : (decoded.data as { pubkey: string }).pubkey;
    } catch {
      this.pubkey = '';
    }

    const currentUser = AuthService.getInstance().getCurrentUser();
    this.isOwnProfile = currentUser?.pubkey === this.pubkey;

    this.loadAndRender();
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.container.innerHTML = '';
  }

  private async loadAndRender(): Promise<void> {
    this.container.innerHTML = `
      <div class="nostrin-list-loading">
        <div class="loading-spinner"></div>
        <p>Loading list...</p>
      </div>
    `;

    try {
      let listData: NostrInListData | null;

      if (this.isOwnProfile) {
        listData = this.listService.getList();
        if (!listData || listData.sections.length === 0) {
          listData = await this.orchestrator.fetchFromRelays(this.pubkey, true);
        }
      } else {
        listData = await this.orchestrator.fetchFromRelays(this.pubkey, true);
      }

      if (!listData || listData.sections.length === 0) {
        this.renderEmpty();
        return;
      }

      this.renderList(listData);
    } catch (error) {
      console.error('Failed to load professional list:', error);
      this.container.innerHTML = '<p class="nostrin-list-error">Failed to load list.</p>';
    }
  }

  private renderEmpty(): void {
    const profileName = this.isOwnProfile ? 'You' : 'This user';
    this.container.innerHTML = `
      <div class="nostrin-list-empty">
        <p>${profileName} ${this.isOwnProfile ? "haven't" : "hasn't"} created a professional list yet.</p>
        ${this.isOwnProfile ? `
          <button class="btn btn--medium btn--primary" data-action="create-list">Create List</button>
        ` : ''}
      </div>
    `;

    if (this.isOwnProfile) {
      this.container.querySelector('[data-action="create-list"]')?.addEventListener('click', () => {
        Router.getInstance().navigate(`/profile/${this.npub}/list/edit`);
      });
    }
  }

  private async loadUsername(): Promise<string> {
    try {
      const profile = await UserProfileService.getInstance().getUserProfile(this.pubkey);
      return profile?.name || profile?.display_name || this.npub.slice(0, 12) + '...';
    } catch {
      return this.npub.slice(0, 12) + '...';
    }
  }

  private async renderList(data: NostrInListData): Promise<void> {
    const username = await this.loadUsername();

    const sectionsHtml = data.sections.map(section => `
      <div class="nostrin-list-section">
        <h2 class="nostrin-list-section__title">${DOMPurify.sanitize(section.title)}</h2>
        <ul class="nostrin-list-section__items">
          ${section.items.map(item => `
            <li class="nostrin-list-section__item">${DOMPurify.sanitize(item)}</li>
          `).join('')}
        </ul>
      </div>
    `).join('');

    this.container.innerHTML = `
      <div class="nostrin-list-view">
        <div class="nostrin-list-header">
          <div class="nostrin-list-header__left">
            <button class="btn btn--medium btn--passive" data-action="back">&larr; Back to ${DOMPurify.sanitize(username)}'s profile</button>
          </div>
          ${this.isOwnProfile ? `
            <div class="nostrin-list-header__actions">
              <button class="btn btn--medium btn--passive" data-action="edit-list">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
                Edit
              </button>
              <button class="btn btn--medium btn--danger" data-action="delete-list">Delete</button>
            </div>
          ` : ''}
        </div>
        ${sectionsHtml}
      </div>
    `;

    this.bindEvents();
  }

  private bindEvents(): void {
    this.container.querySelector('[data-action="edit-list"]')?.addEventListener('click', () => {
      Router.getInstance().navigate(`/profile/${this.npub}/list/edit`);
    });

    this.container.querySelector('[data-action="delete-list"]')?.addEventListener('click', async () => {
      const confirmed = await ModalService.getInstance().confirm({
        title: 'Delete List',
        message: 'This will delete your professional list from all relays. This cannot be undone.',
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

    // Back link
    this.container.querySelector('[data-action="back"]')?.addEventListener('click', (e) => {
      e.preventDefault();
      Router.getInstance().navigate(`/profile/${this.npub}`);
    });
  }
}
