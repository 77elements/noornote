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
import { renderColumns } from './blocks/renderers/ColumnsRenderer';
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
import { CursorRow } from './blocks/CursorRow';
import { createBlock, findBlockInPage, type Block, type BlockType } from './blocks/types';
import { switchTabWithContent, createClosableTab } from '../../helpers/TabsHelper';
import { BookmarkFolderPicker } from '../../components/ui/BookmarkFolderPicker';
import { CustomDropdown } from '../../components/ui/CustomDropdown';
import { MyPageMountsService } from '../../services/MyPageMountsService';
import { MediaUploadService } from '../../services/MediaUploadService';
import { fetchNostrEvents } from '../../helpers/fetchNostrEvents';
import { RelayConfig } from '../../services/RelayConfig';
import { LongFormOrchestrator } from '../../services/orchestration/LongFormOrchestrator';
import { NoteUI } from '../../components/ui/NoteUI';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import DOMPurify from 'dompurify';

const BLOCK_LIBRARY_TAB_ID = 'mypage-block-library';

/** Active editor cursor — either at page level or inside a specific column
 *  of a `columns` block. `index` is the position WITHIN the parent array. */
type Cursor =
  | { scope: 'page'; index: number }
  | { scope: 'column'; columnsBlockId: string; colIndex: number; index: number };

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
  private blockDropdowns: CustomDropdown[] = [];
  private cursorRow: CursorRow | null = null;
  /** Where the next block insert lands. Either at page level between
   *  top-level blocks, or inside a specific column of a `columns` block.
   *  index = -1 means "not set yet, default to end on next render". */
  private cursor: Cursor = { scope: 'page', index: -1 };
  /** Most-recently-used block types in MRU order. In-memory only. */
  private recentBlockTypes: BlockType[] = [];
  /** Currently focused/selected block in the editor. Null = none. UI-only. */
  private selectedBlockId: string | null = null;
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
    this.destroyBlockDropdowns();
    this.destroyCursorRow();
    this.closeBlockLibrary();
    this.container.innerHTML = '';
  }

  private destroyFolderPickers(): void {
    this.folderPickers.forEach(p => p.destroy());
    this.folderPickers = [];
  }

  private destroyBlockDropdowns(): void {
    this.blockDropdowns.forEach(d => d.destroy());
    this.blockDropdowns = [];
  }

  private destroyCursorRow(): void {
    this.cursorRow?.destroy();
    this.cursorRow = null;
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

    if (editable) {
      this.normalizeCursor(page);
    }

    // Page-meta (title/subtitle/description) are no longer rendered as a fixed
    // top section — the user composes them via Heading + Text blocks like any
    // other page content. The fields remain in MypagePageV2 for backwards
    // compatibility when reading old v2 events; they are no-ops in the UI.
    const blocksHtml = editable
      ? this.renderBlocksWithCursor(page.blocks)
      : BlockRenderer.renderAll(page.blocks, { editable: false });

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
    this.destroyBlockDropdowns();

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
        ${blocksHtml}
      </div>
      ${dangerZoneHtml}
    `;

    if (editable) {
      this.mountFolderPickers();
      this.mountBlockDropdowns();
      this.mountCursorRow();
      this.applySelectedBlockClass();
    }
    if (!editable) this.mountEmbeds();

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
    this.insertBlockAtCursor(createBlock(type), {});
    this.bumpRecentBlockType(type);
    ToastService.show(`${type} block added`, 'success');
  }

  /**
   * Insert a block at the current cursor position (page-level for now —
   * column-internal cursor follows in Slice 10b). Cursor advances past
   * the inserted block so consecutive applies stack naturally.
   */
  private insertBlockAtCursor(block: Block, opts: { initialContent?: string }): void {
    const current = this.listService.getDraftV2()
      ?? this.listService.getPublishedV2()
      ?? this.listService.getPageV2();

    // For text blocks created from cursor-row typing, seed the content
    if (opts.initialContent !== undefined && block.type === 'text') {
      block.content = opts.initialContent;
    }

    const next: MypagePageV2 = JSON.parse(JSON.stringify(current));
    const cur = this.cursor;

    if (cur.scope === 'page') {
      const insertIndex = Math.max(0, Math.min(cur.index < 0 ? next.blocks.length : cur.index, next.blocks.length));
      next.blocks.splice(insertIndex, 0, block);
      this.cursor = { scope: 'page', index: insertIndex + 1 };
    } else {
      // Disallow nested columns — design contract (see findBlockInPage docstring)
      if (block.type === 'columns') {
        ToastService.show('Columns inside columns are not supported', 'error');
        return;
      }
      const target = next.blocks.find(b => b.id === cur.columnsBlockId);
      if (!target || target.type !== 'columns') return;
      const col = target.content[cur.colIndex];
      if (!col) return;
      const insertIndex = Math.max(0, Math.min(cur.index < 0 ? col.length : cur.index, col.length));
      col.splice(insertIndex, 0, block);
      this.cursor = { scope: 'column', columnsBlockId: cur.columnsBlockId, colIndex: cur.colIndex, index: insertIndex + 1 };
    }

    this.listService.saveDraftV2(next);
  }

  private bumpRecentBlockType(type: BlockType): void {
    this.recentBlockTypes = [type, ...this.recentBlockTypes.filter(t => t !== type)].slice(0, 10);
  }

  // ──────────────────────────────────────────────────────────────────
  // Cursor-row rendering + mounting
  // ──────────────────────────────────────────────────────────────────

  /**
   * Normalize the active cursor against the current page state. If the
   * referenced columns block / column index is gone (deleted, count-shrunk),
   * fall back to page end. If the index is out of range, clamp.
   */
  private normalizeCursor(page: MypagePageV2): void {
    const cur = this.cursor;
    if (cur.scope === 'page') {
      if (cur.index < 0 || cur.index > page.blocks.length) {
        this.cursor = { scope: 'page', index: page.blocks.length };
      }
      return;
    }
    const target = page.blocks.find(b => b.id === cur.columnsBlockId);
    if (!target || target.type !== 'columns' || cur.colIndex >= target.count) {
      this.cursor = { scope: 'page', index: page.blocks.length };
      return;
    }
    const col = target.content[cur.colIndex] ?? [];
    if (cur.index < 0 || cur.index > col.length) {
      this.cursor = { scope: 'column', columnsBlockId: cur.columnsBlockId, colIndex: cur.colIndex, index: col.length };
    }
  }

  /**
   * Render the editable block list with a cursor-row slot at the active
   * cursor position. The slot is an empty `<div data-cursor-mount>` that
   * `mountCursorRow()` later populates with a `CursorRow` instance. For
   * `columns` blocks, recursively renders each column with its own block
   * list so the cursor can land inside any column.
   */
  private renderBlocksWithCursor(blocks: Block[]): string {
    const slot = `<div data-cursor-mount></div>`;
    const pageCursorIndex = this.cursor.scope === 'page' ? this.cursor.index : -1;

    if (blocks.length === 0 && this.cursor.scope === 'page') return slot;

    const parts: string[] = [];
    for (let i = 0; i < blocks.length; i++) {
      if (i === pageCursorIndex) parts.push(slot);
      const block = blocks[i]!;
      if (block.type === 'columns') {
        parts.push(this.renderColumnsBlockEditable(block));
      } else {
        parts.push(BlockRenderer.renderOne(block, { editable: true }));
      }
      if (block.id === this.selectedBlockId) {
        parts.push(this.renderInlineProperties(block));
      }
    }
    if (pageCursorIndex >= blocks.length) parts.push(slot);
    return parts.join('');
  }

  /**
   * Render a `columns` block with editable columns. Each column either
   * renders its own blocks (with the cursor row injected at the active
   * column-cursor index) or shows a click-to-place placeholder if the
   * column is empty and the cursor is elsewhere.
   */
  private renderColumnsBlockEditable(block: Extract<Block, { type: 'columns' }>): string {
    const slot = `<div data-cursor-mount></div>`;
    const cur = this.cursor;

    return renderColumns(block, {
      editable: true,
      columnInner: (colIndex: number) => {
        const colBlocks = block.content[colIndex] ?? [];
        const cursorHere = cur.scope === 'column'
          && cur.columnsBlockId === block.id
          && cur.colIndex === colIndex;

        if (colBlocks.length === 0) {
          return cursorHere
            ? slot
            : `<div class="mypage-block-columns__placeholder" data-columns-block-id="${block.id}" data-col-index="${colIndex}" role="button" tabindex="0">Click to add blocks here</div>`;
        }

        const inner: string[] = [];
        for (let i = 0; i < colBlocks.length; i++) {
          if (cursorHere && cur.index === i) inner.push(slot);
          const cb = colBlocks[i]!;
          inner.push(BlockRenderer.renderOne(cb, { editable: true }));
          if (cb.id === this.selectedBlockId) {
            inner.push(this.renderInlineProperties(cb));
          }
        }
        if (cursorHere && cur.index >= colBlocks.length) inner.push(slot);
        return inner.join('');
      }
    });
  }

  /**
   * Inline properties panel — rendered directly under the selected block,
   * pushing later blocks down. Empty placeholder for now; real controls
   * (margin, padding, color, alignment, …) follow per block-type later.
   * Works on Mobile too because it's just another row in the same column.
   */
  private renderInlineProperties(block: Block): string {
    return `
      <div class="mypage-block-properties" data-properties-for="${block.id}">
        <div class="mypage-block-properties__header">
          <span class="mypage-block-properties__label">Properties</span>
        </div>
        <div class="mypage-block-properties__body">
          Block properties (margin, padding, color, alignment, …) will live here.
        </div>
      </div>
    `;
  }

  private mountCursorRow(): void {
    this.destroyCursorRow();
    const slot = this.container.querySelector<HTMLElement>('[data-cursor-mount]');
    if (!slot) return;

    this.cursorRow = new CursorRow({
      onTextEntered: (text) => this.handleCursorText(text),
      onBlockTypeChosen: (type) => this.handleCursorBlockType(type),
      getRecentBlockTypes: () => this.recentBlockTypes
    });
    slot.appendChild(this.cursorRow.getElement());
  }

  private handleCursorText(text: string): void {
    const block = createBlock('text');
    this.insertBlockAtCursor(block, { initialContent: text });
    this.bumpRecentBlockType('text');
  }

  private handleCursorBlockType(type: BlockType): void {
    this.insertBlockAtCursor(createBlock(type), {});
    this.bumpRecentBlockType(type);
  }

  /** Move cursor to immediately after a given block id. Works for top-level
   *  blocks AND blocks nested inside a `columns` block's column. */
  private async setCursorAfterBlock(blockId: string): Promise<void> {
    const current = this.listService.getDraftV2()
      ?? this.listService.getPublishedV2()
      ?? this.listService.getPageV2();
    const loc = findBlockInPage(current, blockId);
    if (!loc) return;

    if (loc.parent === current.blocks) {
      this.cursor = { scope: 'page', index: loc.index + 1 };
    } else {
      // Find the columns block that owns this column array
      const owner = current.blocks.find(
        b => b.type === 'columns' && b.content.includes(loc.parent)
      ) as Extract<Block, { type: 'columns' }> | undefined;
      if (!owner) return;
      const colIndex = owner.content.indexOf(loc.parent);
      this.cursor = { scope: 'column', columnsBlockId: owner.id, colIndex, index: loc.index + 1 };
    }

    await this.loadAndRender();
    const el = this.cursorRow?.getElement();
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('mypage-cursor-row--flash');
      setTimeout(() => el.classList.remove('mypage-cursor-row--flash'), 600);
      this.cursorRow?.focus();
    }
  }

  /** Move cursor INTO an empty column. Triggered by clicking the column's
   *  "Click to add blocks here" placeholder. */
  private async setCursorInColumn(columnsBlockId: string, colIndex: number): Promise<void> {
    this.cursor = { scope: 'column', columnsBlockId, colIndex, index: 0 };
    await this.loadAndRender();
    const el = this.cursorRow?.getElement();
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('mypage-cursor-row--flash');
      setTimeout(() => el.classList.remove('mypage-cursor-row--flash'), 600);
      this.cursorRow?.focus();
    }
  }

  /**
   * Select / deselect a block. Pure UI state — no data mutation.
   * Triggers a full re-render so the inline properties panel (rendered
   * directly under the selected block by `renderBlocksWithCursor`) shows
   * up or hides. Re-render keeps cursor row + folder pickers in sync.
   */
  private selectBlock(blockId: string | null): void {
    if (this.selectedBlockId === blockId) return;
    this.selectedBlockId = blockId;
    this.loadAndRender();
  }

  /** Toggle the `--selected` class on the matching wrapper. Called after
   *  every editable re-render so the focus survives state changes. */
  private applySelectedBlockClass(): void {
    this.container.querySelectorAll('.mypage-block-edit--selected').forEach(el => {
      el.classList.remove('mypage-block-edit--selected');
    });
    if (!this.selectedBlockId) return;
    const wrapper = this.container.querySelector(
      `.mypage-block-edit[data-block-id="${this.selectedBlockId}"]`
    );
    wrapper?.classList.add('mypage-block-edit--selected');
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

  private mountBlockDropdowns(): void {
    const slots = this.container.querySelectorAll<HTMLElement>('[data-block-dropdown]');
    slots.forEach(slot => {
      const kind = slot.dataset.blockDropdown;
      const blockId = slot.dataset.blockId;
      if (!kind || !blockId) return;

      if (kind === 'heading-level') {
        const current = slot.dataset.currentValue || '1';
        const dropdown = new CustomDropdown({
          options: [
            { value: '1', label: 'H1' },
            { value: '2', label: 'H2' },
            { value: '3', label: 'H3' }
          ],
          selectedValue: current,
          onChange: (value) => {
            this.mutateDraft((page) => {
              const block = findBlockInPage(page, blockId)?.block;
              if (block && block.type === 'heading') {
                block.level = parseInt(value, 10) as 1 | 2 | 3;
              }
            }, { silent: false });
          }
        });
        slot.appendChild(dropdown.getElement());
        this.blockDropdowns.push(dropdown);
      } else if (kind === 'columns-count') {
        const current = slot.dataset.currentValue || '2';
        const dropdown = new CustomDropdown({
          options: [
            { value: '2', label: '2 columns' },
            { value: '3', label: '3 columns' }
          ],
          selectedValue: current,
          onChange: (value) => this.changeColumnsCount(blockId, parseInt(value, 10) as 2 | 3)
        });
        slot.appendChild(dropdown.getElement());
        this.blockDropdowns.push(dropdown);
      }
    });
  }

  /** Resize a `columns` block. On grow, append empty column arrays. On shrink,
   *  merge dropped columns' blocks into the last surviving column so no data
   *  is lost. */
  private changeColumnsCount(blockId: string, newCount: 2 | 3): void {
    this.mutateDraft((page) => {
      const block = findBlockInPage(page, blockId)?.block;
      if (!block || block.type !== 'columns' || block.count === newCount) return;

      if (newCount > block.count) {
        while (block.content.length < newCount) block.content.push([]);
      } else {
        const survivor = block.content[newCount - 1] ?? [];
        for (let i = newCount; i < block.content.length; i++) {
          survivor.push(...(block.content[i] ?? []));
        }
        block.content[newCount - 1] = survivor;
        block.content.length = newCount;
      }
      block.count = newCount;
    });
  }

  private mountEmbeds(): void {
    const slots = this.container.querySelectorAll<HTMLElement>('[data-embed-mount]');
    slots.forEach(slot => {
      const ref = slot.dataset.nostrRef ?? '';
      if (!ref.trim()) return;
      // Fire-and-forget — slot stays as loading skeleton if fetch fails or
      // the user navigates away. We don't await here so all embeds load
      // in parallel rather than serializing.
      void this.resolveAndMountEmbed(slot, ref);
    });
  }

  private async resolveAndMountEmbed(slot: HTMLElement, nostrRef: string): Promise<void> {
    try {
      const cleaned = nostrRef.replace(/^nostr:/, '').trim();
      let event: NostrEvent | null = null;

      if (cleaned.startsWith('naddr1')) {
        event = await LongFormOrchestrator.getInstance().fetchAddressableEvent(cleaned);
      } else if (cleaned.startsWith('nevent1') || cleaned.startsWith('note1')) {
        const decoded = decodeNip19(cleaned);
        const id = decoded.type === 'nevent'
          ? (decoded.data as { id: string }).id
          : decoded.type === 'note'
          ? (decoded.data as string)
          : '';
        if (id) {
          const result = await fetchNostrEvents({
            relays: RelayConfig.getInstance().getReadRelays(),
            ids: [id],
            limit: 1
          });
          event = result.events[0] ?? null;
        }
      } else if (/^[0-9a-fA-F]{64}$/.test(cleaned)) {
        // Bare hex event id — accept it as a convenience
        const result = await fetchNostrEvents({
          relays: RelayConfig.getInstance().getReadRelays(),
          ids: [cleaned.toLowerCase()],
          limit: 1
        });
        event = result.events[0] ?? null;
      }

      if (!slot.isConnected) return; // user navigated away mid-fetch

      if (!event) {
        slot.innerHTML = `<p class="mypage-block-embed__error">Embed not found: ${this.escapeText(nostrRef)}</p>`;
        return;
      }

      const isUserLoggedIn = AuthService.getInstance().getCurrentUser() !== null;
      const noteElement = NoteUI.createNoteElement(event, {
        collapsible: true,
        islFetchStats: true,
        isLoggedIn: isUserLoggedIn,
        depth: 1
      });
      slot.innerHTML = '';
      slot.appendChild(noteElement);
    } catch (error) {
      console.error('Embed resolution failed:', error);
      if (slot.isConnected) {
        slot.innerHTML = `<p class="mypage-block-embed__error">Failed to load embed</p>`;
      }
    }
  }

  private escapeText(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private handleBookmarkFolderChange(blockId: string, folderName: string): void {
    this.mutateDraft((page) => {
      const block = findBlockInPage(page, blockId)?.block;
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
        case 'cursor-after':           this.setCursorAfterBlock(blockId); break;
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

    // Block selection — click on a block's wrapper (but NOT on its
    // interactive descendants, which have their own handlers) selects it.
    // Click outside any block clears the selection.
    this.container.addEventListener('click', (e) => {
      if (!this.editMode) return;
      const target = e.target as HTMLElement;

      // Click on an empty-column placeholder → put cursor in that column
      const ph = target.closest('.mypage-block-columns__placeholder') as HTMLElement | null;
      if (ph) {
        const cbId = ph.dataset.columnsBlockId;
        const colIdx = ph.dataset.colIndex !== undefined ? parseInt(ph.dataset.colIndex, 10) : -1;
        if (cbId && colIdx >= 0) {
          this.setCursorInColumn(cbId, colIdx);
          return;
        }
      }

      // Skip clicks on interactive controls — those have their own handlers
      if (target.closest('button, input, textarea, select, a, [data-action]')) return;
      // Click inside the inline properties panel of the selected block:
      // keep selection (don't toggle off, the user is interacting with the panel)
      if (target.closest('.mypage-block-properties')) return;
      const wrapper = target.closest('.mypage-block-edit') as HTMLElement | null;
      const blockId = wrapper?.dataset.blockId ?? null;
      // Toggle: clicking the already-selected block deselects
      this.selectBlock(blockId === this.selectedBlockId ? null : blockId);
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
    const draft = this.listService.getDraftV2()
      ?? this.listService.getPublishedV2()
      ?? this.listService.getPageV2();
    const next: MypagePageV2 = JSON.parse(JSON.stringify(draft));
    updater(next);
    this.listService.saveDraftV2(next, { silent: opts.silent === true });
  }

  private handleBlockFieldInput(blockId: string, field: string, el: HTMLInputElement | HTMLTextAreaElement): void {
    // Skip "new-item" — that input is consumed on Enter / + click, not on input
    if (field === 'new-item') return;

    const itemIndex = el.dataset?.itemIndex !== undefined ? parseInt(el.dataset.itemIndex, 10) : -1;
    this.mutateDraft((page) => {
      const block = findBlockInPage(page, blockId)?.block;
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
      } else if (block.type === 'embed') {
        if (field === 'nostrRef') block.nostrRef = el.value;
      }
    }, { silent: true });
  }

  private deleteBlock(blockId: string): void {
    this.mutateDraft((page) => {
      const loc = findBlockInPage(page, blockId);
      if (!loc) return;
      loc.parent.splice(loc.index, 1);
    });
  }

  private moveBlock(blockId: string, delta: -1 | 1): void {
    this.mutateDraft((page) => {
      const loc = findBlockInPage(page, blockId);
      if (!loc) return;
      const j = loc.index + delta;
      if (j < 0 || j >= loc.parent.length) return;
      const tmp = loc.parent[loc.index]!;
      loc.parent[loc.index] = loc.parent[j]!;
      loc.parent[j] = tmp;
    });
  }

  private addListItem(blockId: string): void {
    const input = this.container.querySelector(`[data-block-id="${blockId}"][data-field="new-item"]`) as HTMLInputElement | null;
    if (!input) return;
    const value = input.value.trim();
    if (!value) return;
    this.mutateDraft((page) => {
      const block = findBlockInPage(page, blockId)?.block;
      if (block?.type === 'list') block.items.push(value);
    });
  }

  private deleteListItem(blockId: string, itemIndex: number): void {
    this.mutateDraft((page) => {
      const block = findBlockInPage(page, blockId)?.block;
      if (block?.type === 'list') block.items.splice(itemIndex, 1);
    });
  }

  private addLink(blockId: string): void {
    this.mutateDraft((page) => {
      const block = findBlockInPage(page, blockId)?.block;
      if (block?.type === 'links') block.items.push({ label: '', url: '' });
    });
  }

  private deleteLink(blockId: string, itemIndex: number): void {
    this.mutateDraft((page) => {
      const block = findBlockInPage(page, blockId)?.block;
      if (block?.type === 'links') block.items.splice(itemIndex, 1);
    });
  }

  private triggerImageUpload(blockId: string): void {
    const fileInput = this.container.querySelector(`[data-block-id="${blockId}"][data-image-file]`) as HTMLInputElement | null;
    fileInput?.click();
  }

  private addGalleryUrl(blockId: string): void {
    this.mutateDraft((page) => {
      const block = findBlockInPage(page, blockId)?.block;
      if (block?.type === 'gallery') block.urls.push('');
    });
  }

  private deleteGalleryUrl(blockId: string, itemIndex: number): void {
    this.mutateDraft((page) => {
      const block = findBlockInPage(page, blockId)?.block;
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
        const block = findBlockInPage(page, blockId)?.block;
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
          const block = findBlockInPage(page, blockId)?.block;
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
}
