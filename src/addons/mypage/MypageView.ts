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
import { MypageService, mypageHasContent, type MypageListData } from '../../services/MypageService';
import { BlockRenderer } from './blocks/BlockRenderer';
import { migrateV1ToV2 } from './blocks/migrate';
import type { MypagePageV2 } from './blocks/types';
import { UserProfileService } from '../../services/UserProfileService';
import { Router } from '../../services/Router';
import { ModalService } from '../../services/ModalService';
import { ToastService } from '../../services/ToastService';
import { decodeNip19 } from '../../services/NostrToolsAdapter';
import { ProfileListsComponent } from '../../components/profile/ProfileListsComponent';
import { EventBus } from '../../services/EventBus';
import { BlockLibraryView } from './blocks/BlockLibraryView';
import { createBlock, type BlockType } from './blocks/types';
import { switchTabWithContent, createClosableTab } from '../../helpers/TabsHelper';
import { BookmarkFolderPicker } from '../../components/ui/BookmarkFolderPicker';
import { MyPageMountsService } from '../../services/MyPageMountsService';
import { MediaUploadService } from '../../services/MediaUploadService';
import DOMPurify from 'dompurify';

const BLOCK_LIBRARY_TAB_ID = 'mypage-block-library';

export class MypageView extends View {
  private container: HTMLElement;
  private npub: string;
  private pubkey: string;
  private isOwnProfile: boolean;
  private orchestrator: MypageOrchestrator;
  private listService: MypageService;
  private mountsComponent: ProfileListsComponent | null = null;
  private blockLibrary: BlockLibraryView | null = null;
  private editMode: boolean = false;
  private folderPickers: BookmarkFolderPicker[] = [];
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
    this.setupEditDelegation();
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
    this.destroyFolderPickers();
    this.closeBlockLibrary();
    this.container.innerHTML = '';
  }

  private destroyFolderPickers(): void {
    this.folderPickers.forEach(p => p.destroy());
    this.folderPickers = [];
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
    this.eventBusSubscriptions.push(
      eventBus.on('mypageDraftV2:changed', () => this.loadAndRender())
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
        if (!mypageHasContent(listData)) {
          listData = await this.orchestrator.fetchFromRelays(this.pubkey, true);
          if (mypageHasContent(listData)) {
            this.listService.setListFromRelay(listData!);
          }
        }
      } else {
        listData = await this.orchestrator.fetchFromRelays(this.pubkey, true);
      }

      const hasList = mypageHasContent(listData);

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
              <button class="btn btn--medium btn--passive" data-action="open-block-editor">
                <svg width="14" height="14"><use href="#icon-edit"/></svg>
                Block Editor
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

    // Render priority for own profile:
    //   1. v2 draft (work-in-progress, set by Block Library Apply)
    //   2. v2 published (mirror of last successful publish — survives reloads)
    //   3. v1 migrated to v2 (legacy fallback — pre-v2 published state)
    // For foreign profiles: only v1 from relays migrated. Their mounts come
    // from ProfileListsComponent (separately fetches from their relays).
    let page: MypagePageV2;
    if (this.isOwnProfile) {
      page = this.listService.getDraftV2()
        ?? this.listService.getPublishedV2()
        ?? this.listService.getPageV2();
    } else {
      page = migrateV1ToV2(data, []);
    }

    const editable = this.editMode && this.isOwnProfile;
    const title = page.title || '';
    const subtitle = page.subtitle || '';
    const description = page.description || '';

    const pageHeaderHtml = editable
      ? `
        <div class="mypage-view__pagefields">
          <div class="form__row">
            <label for="mypage-page-title">Page title</label>
            <input id="mypage-page-title" type="text" class="input input--title" data-page-field="title" value="${this.escapeAttr(title)}" placeholder="Optional page title..." />
          </div>
          <div class="form__row">
            <label for="mypage-page-subtitle">Subtitle</label>
            <input id="mypage-page-subtitle" type="text" class="input" data-page-field="subtitle" value="${this.escapeAttr(subtitle)}" placeholder="Optional subtitle..." />
          </div>
          <div class="form__row">
            <label for="mypage-page-description">Description</label>
            <textarea id="mypage-page-description" class="textarea textarea--small" data-page-field="description" placeholder="Optional description...">${this.escapeText(description)}</textarea>
          </div>
        </div>`
      : `
        ${title.trim() ? `<h1 class="mypage-view__title">${DOMPurify.sanitize(title)}</h1>` : ''}
        ${subtitle.trim() ? `<p class="mypage-view__subtitle">${DOMPurify.sanitize(subtitle)}</p>` : ''}
        ${description.trim() ? `<p class="mypage-view__description">${DOMPurify.sanitize(description)}</p>` : ''}
      `;

    const blocksHtml = BlockRenderer.renderAll(page.blocks, { editable });

    const dangerZoneHtml = this.isOwnProfile
      ? `
        <div class="mypage-danger-zone">
          <button class="btn btn--mini btn--danger" data-action="delete-list">Delete page from relays</button>
          <p class="mypage-danger-zone__hint">Removes the published page everywhere. Mounted bookmark folders are not affected.</p>
        </div>
      `
      : '';

    // Tear down old picker instances before innerHTML replaces their DOM
    this.destroyFolderPickers();

    // Danger zone lives OUTSIDE .mypage-view so it stays the last element on
    // the page even after renderMounts() appends bookmark-folder content
    // inside .mypage-view.
    const leftButtonHtml = editable
      ? `<button class="btn btn--medium btn--passive" data-action="preview-page" title="Close the editor and see the page as visitors see it">Preview Page</button>`
      : `<button class="btn btn--medium btn--passive" data-action="back">&larr; Back to ${DOMPurify.sanitize(username)}'s profile</button>`;

    this.container.innerHTML = `
      <div class="mypage-view">
        <div class="mypage-header">
          <div class="mypage-header__left">
            ${leftButtonHtml}
          </div>
          ${this.isOwnProfile ? `
            <div class="mypage-header__actions">
              <button class="btn btn--medium btn--passive" data-action="open-block-editor" title="Open Block Library in the right sidebar">
                <svg width="14" height="14"><use href="#icon-edit"/></svg>
                Block Editor
              </button>
            </div>
          ` : ''}
        </div>
        ${pageHeaderHtml}
        ${blocksHtml}
      </div>
      ${dangerZoneHtml}
    `;

    if (editable) this.mountFolderPickers();

    this.bindHeaderEvents();
  }

  private async renderMounts(): Promise<void> {
    const view = this.container.querySelector('.mypage-view');
    if (!view) return;

    // Anchor mounts to the last child of the view so they appear after the list
    const lastChild = view.lastElementChild;
    if (!lastChild) return;

    this.mountsComponent = new ProfileListsComponent(this.pubkey, 'mypage');

    // For own profile: extract folder names from the current v2 page
    // (draft → published → migrated v1) so the readonly view reflects
    // the user's in-progress block-editor changes immediately, without
    // waiting for publish + MyPageMountsService sync.
    if (this.isOwnProfile) {
      const page = this.listService.getDraftV2()
        ?? this.listService.getPublishedV2()
        ?? this.listService.getPageV2();
      const folderNames = page.blocks
        .filter((b): b is Extract<typeof page.blocks[number], { type: 'bookmark-folder' }> => b.type === 'bookmark-folder')
        .map(b => b.folderName)
        .filter(name => !!name);
      await this.mountsComponent.render(lastChild, folderNames);
    } else {
      await this.mountsComponent.render(lastChild);
    }
  }

  private bindHeaderEvents(): void {
    this.container.querySelector('[data-action="open-block-editor"]')?.addEventListener('click', () => {
      this.openBlockLibrary();
    });

    this.container.querySelector('[data-action="preview-page"]')?.addEventListener('click', () => {
      this.closeBlockLibrary();
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

  /**
   * Inject the Block Library tab into the SCC and switch to it.
   * Tab is removed when MypageView destroys (= user navigates away).
   */
  private openBlockLibrary(): void {
    const sidebarTabs = document.querySelector('#sidebar-tabs');
    const contentBody = document.querySelector('.secondary-content-body');
    const secondaryContent = document.querySelector('.secondary-content') as HTMLElement | null;
    if (!sidebarTabs || !contentBody || !secondaryContent) return;

    // Reuse existing tab if already open
    let tabContent = contentBody.querySelector(`[data-tab-content="${BLOCK_LIBRARY_TAB_ID}"]`) as HTMLElement | null;
    if (!tabContent) {
      const tabButton = createClosableTab(
        BLOCK_LIBRARY_TAB_ID,
        'Block Library',
        () => this.closeBlockLibrary()
      );
      tabButton.addEventListener('click', () => switchTabWithContent(secondaryContent, BLOCK_LIBRARY_TAB_ID));
      sidebarTabs.appendChild(tabButton);

      this.blockLibrary = new BlockLibraryView({
        onApply: (type) => this.applyBlock(type),
        onDiscard: () => this.discardDraft(),
        onPublish: () => this.publishDraft(),
        getHasDraft: () => this.listService.hasDraftV2()
      });
      tabContent = document.createElement('div');
      tabContent.className = 'tab-content';
      tabContent.dataset.tabContent = BLOCK_LIBRARY_TAB_ID;
      tabContent.appendChild(this.blockLibrary.getElement());
      contentBody.appendChild(tabContent);
    }

    switchTabWithContent(secondaryContent, BLOCK_LIBRARY_TAB_ID);
    if (!this.editMode) {
      this.editMode = true;
      this.loadAndRender();
    }
  }

  private closeBlockLibrary(): void {
    document.querySelector(`#sidebar-tabs > [data-tab="${BLOCK_LIBRARY_TAB_ID}"]`)?.remove();
    document.querySelector(`.secondary-content-body > [data-tab-content="${BLOCK_LIBRARY_TAB_ID}"]`)?.remove();
    this.blockLibrary?.destroy();
    this.blockLibrary = null;

    // After removing the tab, fall back to System Logs (the always-present tab).
    const secondaryContent = document.querySelector('.secondary-content') as HTMLElement | null;
    if (secondaryContent) {
      const stillActive = secondaryContent.querySelector('.tab--active');
      if (!stillActive) switchTabWithContent(secondaryContent, 'system-log');
    }

    if (this.editMode) {
      this.editMode = false;
      this.loadAndRender();
    }
  }

  /**
   * Apply a block from the Library: append to the current draft (or seed
   * a new draft from the migrated v1 page) and persist locally as v2.
   * The 'mypageDraftV2:changed' event triggers MypageView re-render.
   */
  private applyBlock(type: BlockType): void {
    const current = this.listService.getDraftV2() ?? this.listService.getPageV2();
    const block = createBlock(type);

    // Sensible defaults so the new block is visible immediately
    if (block.type === 'heading')         block.text = 'New heading';
    if (block.type === 'text')            block.content = 'New text block.';
    if (block.type === 'list')            block.title = 'New list';
    if (block.type === 'links')           block.title = 'Links';
    if (block.type === 'bookmark-folder') block.folderName = ''; // user picks via picker

    const next: MypagePageV2 = {
      ...current,
      blocks: [...current.blocks, block]
    };
    this.listService.saveDraftV2(next);
    ToastService.show(`${type} block added`, 'success');
  }

  private async discardDraft(): Promise<void> {
    const confirmed = await ModalService.getInstance().confirm({
      title: 'Discard draft',
      message: 'This removes all unpublished changes from this device. The page on relays is not affected. Cannot be undone.',
      confirmDestructive: true,
    });
    if (!confirmed) return;
    this.listService.clearDraftV2();
    ToastService.show('Draft discarded', 'success');
  }

  private async publishDraft(): Promise<void> {
    const draft = this.listService.getDraftV2();
    if (!draft) {
      ToastService.show('No draft to publish', 'error');
      return;
    }

    try {
      await this.orchestrator.publishV2ToRelays(draft);
      this.listService.savePublishedV2(draft);

      // Sync MyPageMountsService from bookmark-folder blocks so
      // ProfileListsComponent (legacy renderer at the page bottom) reflects
      // the new mount selection. Slice 7 will move bookmark-folder rendering
      // inline and this sync becomes obsolete.
      const folderNames = draft.blocks
        .filter((b): b is Extract<typeof draft.blocks[number], { type: 'bookmark-folder' }> => b.type === 'bookmark-folder')
        .map(b => b.folderName)
        .filter(name => !!name);
      MyPageMountsService.getInstance().setMountsFromRelay(folderNames);

      this.listService.clearDraftV2();
      ToastService.show('Page published', 'success');
      this.closeBlockLibrary();
    } catch (error) {
      console.error('Failed to publish page:', error);
      ToastService.show('Publish failed — try again', 'error');
    }
  }

  private mountFolderPickers(): void {
    const slots = this.container.querySelectorAll<HTMLElement>('[data-bookmark-folder-picker]');
    slots.forEach(slot => {
      const blockId = slot.dataset.blockId;
      if (!blockId) return;
      const currentFolder = slot.dataset.folderName || '';

      const picker = new BookmarkFolderPicker({
        ...(currentFolder ? { selectedFolderName: currentFolder } : {}),
        onChange: (folderName) => this.handleBookmarkFolderChange(blockId, folderName ?? '')
      });
      slot.appendChild(picker.getElement());
      this.folderPickers.push(picker);
    });
  }

  private handleBookmarkFolderChange(blockId: string, folderName: string): void {
    this.mutateDraft((page) => {
      const block = page.blocks.find(b => b.id === blockId);
      if (block?.type === 'bookmark-folder') block.folderName = folderName;
    }, { silent: true });
  }

  // ──────────────────────────────────────────────────────────────────
  // Edit-mode event delegation
  // ──────────────────────────────────────────────────────────────────

  /**
   * Single delegated listener attached to this.container at construction.
   * Survives re-renders. Dispatches by data-action / data-field /
   * data-page-field attribute. No-ops in readonly mode (no matching
   * elements in the DOM).
   */
  private setupEditDelegation(): void {
    this.container.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement | HTMLTextAreaElement;
      const pageField = target.dataset?.pageField;
      if (pageField) { this.handlePageFieldInput(pageField, target.value); return; }

      const blockId = target.dataset?.blockId;
      const field = target.dataset?.field;
      if (blockId && field) this.handleBlockFieldInput(blockId, field, target);
    });

    this.container.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
      if (!btn) return;
      const action = btn.dataset.action!;
      const blockId = btn.dataset.blockId;
      if (!blockId) return;
      const itemIndex = btn.dataset.itemIndex !== undefined ? parseInt(btn.dataset.itemIndex, 10) : -1;

      switch (action) {
        case 'delete':                 this.deleteBlock(blockId); break;
        case 'move-up':                this.moveBlock(blockId, -1); break;
        case 'move-down':              this.moveBlock(blockId, +1); break;
        case 'add-item':               this.addListItem(blockId); break;
        case 'delete-item':            if (itemIndex >= 0) this.deleteListItem(blockId, itemIndex); break;
        case 'add-link':               this.addLink(blockId); break;
        case 'delete-link':            if (itemIndex >= 0) this.deleteLink(blockId, itemIndex); break;
        case 'upload-image':           this.triggerImageUpload(blockId); break;
        case 'add-gallery-url':        this.addGalleryUrl(blockId); break;
        case 'delete-gallery-url':     if (itemIndex >= 0) this.deleteGalleryUrl(blockId, itemIndex); break;
        case 'upload-gallery-images':  this.triggerGalleryUpload(blockId); break;
      }
    });

    this.container.addEventListener('change', async (e) => {
      const target = e.target as HTMLInputElement;
      if (target?.dataset?.imageFile !== undefined) {
        const blockId = target.dataset.blockId;
        const file = target.files?.[0];
        if (!blockId || !file) return;
        target.value = '';
        await this.handleImageUpload(blockId, file);
        return;
      }
      if (target?.dataset?.galleryFiles !== undefined) {
        const blockId = target.dataset.blockId;
        const files = Array.from(target.files ?? []);
        if (!blockId || files.length === 0) return;
        target.value = '';
        await this.handleGalleryUpload(blockId, files);
        return;
      }
    });

    this.container.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key !== 'Enter') return;
      const target = e.target as HTMLInputElement;
      if (target.dataset?.field === 'new-item') {
        e.preventDefault();
        const blockId = target.dataset.blockId;
        if (blockId) this.addListItem(blockId);
      }
    });
  }

  /**
   * Mutate the draft via a callback, save, optionally trigger re-render.
   * Field-level edits use silent=true (skip re-render to keep input focus).
   * Structural changes (delete/move/add) re-render.
   */
  private mutateDraft(updater: (page: MypagePageV2) => void, opts: { silent?: boolean } = {}): void {
    const draft = this.listService.getDraftV2() ?? this.listService.getPageV2();
    const next: MypagePageV2 = JSON.parse(JSON.stringify(draft));
    updater(next);
    this.listService.saveDraftV2(next, { silent: opts.silent === true });
  }

  private handlePageFieldInput(field: string, value: string): void {
    this.mutateDraft((page) => {
      if (field === 'title')       page.title = value;
      if (field === 'subtitle')    page.subtitle = value;
      if (field === 'description') page.description = value;
    }, { silent: true });
  }

  private handleBlockFieldInput(blockId: string, field: string, el: HTMLInputElement | HTMLTextAreaElement): void {
    // Skip "new-item" — that input is consumed on Enter / + click, not on input
    if (field === 'new-item') return;

    const itemIndex = el.dataset?.itemIndex !== undefined ? parseInt(el.dataset.itemIndex, 10) : -1;
    this.mutateDraft((page) => {
      const block = page.blocks.find(b => b.id === blockId);
      if (!block) return;

      if (block.type === 'heading') {
        if (field === 'text')  block.text = el.value;
        if (field === 'level') block.level = parseInt(el.value, 10) as 1 | 2 | 3;
      } else if (block.type === 'text') {
        if (field === 'content') block.content = el.value;
      } else if (block.type === 'list') {
        if (field === 'title') block.title = el.value;
        if (field === 'item' && itemIndex >= 0) block.items[itemIndex] = el.value;
      } else if (block.type === 'links') {
        if (field === 'title') block.title = el.value;
        if (field === 'link-label' && itemIndex >= 0 && block.items[itemIndex]) block.items[itemIndex]!.label = el.value;
        if (field === 'link-url' && itemIndex >= 0 && block.items[itemIndex]) block.items[itemIndex]!.url = el.value;
      } else if (block.type === 'image') {
        if (field === 'url')     block.url = el.value;
        if (field === 'alt')     block.alt = el.value;
        if (field === 'caption') block.caption = el.value;
      } else if (block.type === 'gallery') {
        if (field === 'gallery-url' && itemIndex >= 0) block.urls[itemIndex] = el.value;
      }
    }, { silent: true });
  }

  private deleteBlock(blockId: string): void {
    this.mutateDraft((page) => {
      page.blocks = page.blocks.filter(b => b.id !== blockId);
    });
  }

  private moveBlock(blockId: string, delta: -1 | 1): void {
    this.mutateDraft((page) => {
      const i = page.blocks.findIndex(b => b.id === blockId);
      if (i < 0) return;
      const j = i + delta;
      if (j < 0 || j >= page.blocks.length) return;
      const tmp = page.blocks[i]!;
      page.blocks[i] = page.blocks[j]!;
      page.blocks[j] = tmp;
    });
  }

  private addListItem(blockId: string): void {
    const input = this.container.querySelector(`[data-block-id="${blockId}"][data-field="new-item"]`) as HTMLInputElement | null;
    if (!input) return;
    const value = input.value.trim();
    if (!value) return;
    this.mutateDraft((page) => {
      const block = page.blocks.find(b => b.id === blockId);
      if (block?.type === 'list') block.items.push(value);
    });
  }

  private deleteListItem(blockId: string, itemIndex: number): void {
    this.mutateDraft((page) => {
      const block = page.blocks.find(b => b.id === blockId);
      if (block?.type === 'list') block.items.splice(itemIndex, 1);
    });
  }

  private addLink(blockId: string): void {
    this.mutateDraft((page) => {
      const block = page.blocks.find(b => b.id === blockId);
      if (block?.type === 'links') block.items.push({ label: '', url: '' });
    });
  }

  private deleteLink(blockId: string, itemIndex: number): void {
    this.mutateDraft((page) => {
      const block = page.blocks.find(b => b.id === blockId);
      if (block?.type === 'links') block.items.splice(itemIndex, 1);
    });
  }

  private triggerImageUpload(blockId: string): void {
    const fileInput = this.container.querySelector(`[data-block-id="${blockId}"][data-image-file]`) as HTMLInputElement | null;
    fileInput?.click();
  }

  private addGalleryUrl(blockId: string): void {
    this.mutateDraft((page) => {
      const block = page.blocks.find(b => b.id === blockId);
      if (block?.type === 'gallery') block.urls.push('');
    });
  }

  private deleteGalleryUrl(blockId: string, itemIndex: number): void {
    this.mutateDraft((page) => {
      const block = page.blocks.find(b => b.id === blockId);
      if (block?.type === 'gallery') block.urls.splice(itemIndex, 1);
    });
  }

  private triggerGalleryUpload(blockId: string): void {
    const fileInput = this.container.querySelector(`[data-block-id="${blockId}"][data-gallery-files]`) as HTMLInputElement | null;
    fileInput?.click();
  }

  private async handleGalleryUpload(blockId: string, files: File[]): Promise<void> {
    const images = files.filter(f => f.type.startsWith('image/'));
    if (images.length === 0) {
      ToastService.show('Please select image files', 'error');
      return;
    }
    const uploadBtn = this.container.querySelector(`[data-block-id="${blockId}"][data-action="upload-gallery-images"]`) as HTMLButtonElement | null;
    if (!uploadBtn) return;

    const originalText = uploadBtn.textContent ?? '';
    uploadBtn.disabled = true;

    try {
      const results = await MediaUploadService.getInstance().uploadFiles(images, (fileIndex, _progress, totalFiles) => {
        uploadBtn.textContent = `Uploading ${fileIndex + 1}/${totalFiles}…`;
      });
      const newUrls = results.filter(r => r.success && r.url).map(r => r.url as string);
      if (newUrls.length === 0) return;
      this.mutateDraft((page) => {
        const block = page.blocks.find(b => b.id === blockId);
        if (block?.type === 'gallery') block.urls.push(...newUrls);
      });
    } catch (error) {
      console.error('Gallery upload failed:', error);
      ToastService.show('Gallery upload failed', 'error');
    } finally {
      if (uploadBtn.isConnected) {
        uploadBtn.disabled = false;
        uploadBtn.textContent = originalText;
      }
    }
  }

  private async handleImageUpload(blockId: string, file: File): Promise<void> {
    if (!file.type.startsWith('image/')) {
      ToastService.show('Please select an image file', 'error');
      return;
    }
    const uploadBtn = this.container.querySelector(`[data-block-id="${blockId}"][data-action="upload-image"]`) as HTMLButtonElement | null;
    if (!uploadBtn) return;

    const originalHTML = uploadBtn.innerHTML;
    uploadBtn.disabled = true;
    // Inline the SVG (instead of <use href="#icon-upload-progress">) because
    // <use> clones its referenced symbol into shadow DOM — querySelector
    // can't reach into shadow DOM, so JS-driven strokeDashoffset updates
    // don't work. The same pattern in PostEditorToolbar / ImageUploader
    // appears to silently no-op for the same reason.
    uploadBtn.innerHTML = `
      <svg width="20" height="20" class="upload-progress" viewBox="0 0 24 24">
        <circle class="upload-progress-bg" cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" opacity="0.2"/>
        <circle class="upload-progress-bar" cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="62.83" stroke-dashoffset="62.83"/>
      </svg>
    `;

    const updateProgress = (progress: number) => {
      const bar = uploadBtn.querySelector('.upload-progress-bar') as SVGCircleElement | null;
      if (!bar) return;
      const circumference = 62.83; // 2 * PI * r=10
      const offset = circumference - (progress / 100) * circumference;
      bar.style.strokeDashoffset = String(offset);
    };

    try {
      const result = await MediaUploadService.getInstance().uploadFile(file, updateProgress);
      if (result.success && result.url) {
        const url = result.url;
        this.mutateDraft((page) => {
          const block = page.blocks.find(b => b.id === blockId);
          if (block?.type === 'image') block.url = url;
        });
      }
    } catch (error) {
      console.error('Image upload failed:', error);
      ToastService.show('Image upload failed', 'error');
    } finally {
      // Re-render via mutateDraft may have already rebuilt the button — guard
      if (uploadBtn.isConnected) {
        uploadBtn.disabled = false;
        uploadBtn.innerHTML = originalHTML;
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // tiny html helpers (avoid pulling DOMPurify into attribute paths)
  // ──────────────────────────────────────────────────────────────────

  private escapeAttr(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private escapeText(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
