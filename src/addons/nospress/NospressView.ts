/**
 * NospressView
 * Readonly display of a user's NosPress (custom list + mounted bookmark folders)
 *
 * Route: /profile/:npub/page
 * Aggregates the custom list (freetext sections) and any mounted bookmark
 * folders into one personal page. Owner sees Edit + Delete buttons (apply
 * only to the custom list — folder mounts are managed via bookmarks).
 *
 * @purpose Display NosPress for any user
 * @used-by ViewMountingService (route: nospress)
 */

import { View } from '../../components/views/View';
import { NospressOrchestrator } from '../../services/orchestration/NospressOrchestrator';
import { NospressPageIndexOrchestrator } from '../../services/orchestration/NospressPageIndexOrchestrator';
import { NospressMenuOrchestrator } from '../../services/orchestration/NospressMenuOrchestrator';
import { NospressService } from '../../services/NospressService';
import { NospressPageIndexService } from '../../services/NospressPageIndexService';
import { NospressMenuService } from '../../services/NospressMenuService';
import { HOME_SLUG, GLOBAL_HEADER_SLUG, GLOBAL_FOOTER_SLUG, normalizeSlug, isValidSlug, type PageIndexEntry } from './blocks/pageIndex';
import { PRIMARY_MENU_ID, type NavItem, type NospressMenu } from './blocks/menu';
import { BlockRenderer } from './blocks/BlockRenderer';
import { renderColumns } from './blocks/renderers/ColumnsRenderer';
import { renderDiv } from './blocks/renderers/DivRenderer';
import { UserProfileService } from '../../services/UserProfileService';
import { Router } from '../../services/Router';
import { ModalService } from '../../services/ModalService';
import { ToastService } from '../../services/ToastService';
import { decodeNip19 } from '../../services/NostrToolsAdapter';
import { ProfileListsComponent } from '../../components/profile/ProfileListsComponent';
import { EventBus } from '../../services/EventBus';
import { FullscreenOverlay } from '../../components/ui/FullscreenOverlay';
import { BlockLibraryView } from './blocks/BlockLibraryView';
import { CursorRow } from './blocks/CursorRow';
import { createBlock, findBlockInPage, DIV_TAGS, type Block, type BlockType, type DivTag, type NospressPageV2 } from './blocks/types';
import {
  renderPropertyPanel,
  sanitizeCssIdent,
  writeStyleField,
  type CommonStyle,
} from './blocks/styles';
import { removeUserCss } from './cssScope';
import { bindCssTextareaUx } from './cssTextareaUx';
import { setupTabClickHandlers, switchTabWithContent } from '../../helpers/TabsHelper';
import { escapeHtml } from '../../helpers/escapeHtml';
import { setupGridDragDrop } from '../../helpers/gridDragDrop';
import { BookmarkFolderPicker } from '../../components/ui/BookmarkFolderPicker';
import { CustomDropdown } from '../../components/ui/CustomDropdown';
import { MediaUploadService } from '../../services/MediaUploadService';
import { mountNospressProfileCards } from './profileCardMount';
import { mountNospressArticlesLists } from './articlesListMount';
import { mountNospressWeblogs } from './weblogMount';
import { mountNospressNavMenus } from './navMenuMount';
import type { UserIdentity } from '../../components/shared/UserIdentity';
import type { ProfileArticlesCarousel } from '../../components/profile/ProfileArticlesCarousel';

/** Reserved value for `selectedBlockId` that selects the virtual Page wrapper
 *  (the always-present outer frame in the editor). Not a real Block.id —
 *  prefixed with `__` so it can never collide with a UUID. */
const PAGE_SELECTION_ID = '__page__';

/** Active editor cursor — page level, inside a `columns` block's column, or
 *  inside a `div` block's children. `index` is the position WITHIN the
 *  parent array. */
type Cursor =
  | { scope: 'page'; index: number }
  | { scope: 'column'; columnsBlockId: string; colIndex: number; index: number }
  | { scope: 'div'; divBlockId: string; index: number };

export class NospressView extends View {
  private container: HTMLElement;
  private npub: string;
  private pubkey: string;
  private orchestrator: NospressOrchestrator;
  private listService: NospressService;
  /** One ProfileListsComponent per inline bookmark-folder block in the page,
   *  mounted into the slot the BookmarkFolderRenderer's readonly path emits. */
  private inlineMountsComponents: ProfileListsComponent[] = [];
  private profileCardInstances: UserIdentity[] = [];
  private articlesCarousels: ProfileArticlesCarousel[] = [];
  private blockLibrary: BlockLibraryView | null = null;
  /** Always true for own profile (foreign profiles redirect on construction).
   *  Kept as a field instead of a const so existing call sites that read it
   *  read consistently — semantically NosPress is now always edit mode. */
  private editMode: boolean = true;
  private folderPickers: BookmarkFolderPicker[] = [];
  private blockDropdowns: CustomDropdown[] = [];
  private cursorRow: CursorRow | null = null;
  /** Where the next block insert lands. Either at page level between
   *  top-level blocks, or inside a specific column of a `columns` block.
   *  index = -1 means "not set yet, default to end on next render". */
  private cursor: Cursor = { scope: 'page', index: -1 };
  /** Most-recently-used block types in MRU order. In-memory only. */
  private recentBlockTypes: BlockType[] = [];
  /** Currently focused/selected block in the editor. Null = none. UI-only.
   *  May also be PAGE_SELECTION_ID — selects the virtual Page wrapper, whose
   *  properties panel surfaces site-level options (color, background, etc.). */
  private selectedBlockId: string | null = null;
  private eventBusSubscriptions: string[] = [];
  /** Live in-memory edit state. All mutations go here; persisted to draft
   *  storage only when the user clicks Save. Null until first edit. */
  private editingPage: NospressPageV2 | null = null;
  private isDirty: boolean = false;
  /** Fullscreen overlay handle. Active means this.container is currently
   *  re-parented into the overlay's editor slot. */
  private fullscreenOverlay: FullscreenOverlay | null = null;
  private fullscreenOriginParent: HTMLElement | null = null;
  private fullscreenOriginAnchor: Node | null = null;
  /** Reference to the 70/30 split element so the library-toggle button can
   *  flip a modifier class without re-creating the overlay. */
  private fullscreenSplit: HTMLElement | null = null;
  private libraryToggleBtn: HTMLButtonElement | null = null;
  private libraryHidden: boolean = false;
  /** Right pane (tabs container). Holds the Blocks + Properties + Pages tabs. */
  private rightPaneEl: HTMLElement | null = null;
  /** Direct ref to the Properties tab body — re-rendered on selectBlock. */
  private propertiesTabContent: HTMLElement | null = null;
  /** Direct ref to the Pages tab body — re-rendered on page-index changes. */
  private pagesTabContent: HTMLElement | null = null;
  /** Direct ref to the Nav tab body — re-rendered on menu changes. */
  private navTabContent: HTMLElement | null = null;
  /** Currently edited page-slug. '' = home (legacy d-tag noornote/list).
   *  Initialized from `?page=<slug>` URL query-param, falls back to home. */
  private activeSlug: string = HOME_SLUG;
  /** Which slot of the active page is being edited.
   *   - 'body'   → page-specific blocks (default; the only target with real
   *               data in Slice 1)
   *   - 'header' → site-wide global header (Slice 2)
   *   - 'footer' → site-wide global footer (Slice 2)
   *  Reflected in the editor h2 and the active pill in the Pages tab. */
  private editingTarget: 'body' | 'header' | 'footer' = 'body';
  private pageIndexService: NospressPageIndexService;
  private pageIndexOrchestrator: NospressPageIndexOrchestrator;
  private menuService: NospressMenuService;
  private menuOrchestrator: NospressMenuOrchestrator;
  /** True when the Custom-CSS editor panel is visible between header and
   *  the page-edit area. Toggled by the overlay "CSS Editor" button or the
   *  Library "Custom CSS" entry. UI-only; no relay impact. */
  private cssEditorOpen: boolean = false;

  constructor(npub: string) {
    super();
    this.npub = npub;
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--nospress';
    this.orchestrator = NospressOrchestrator.getInstance();
    this.listService = NospressService.getInstance();
    this.pageIndexService = NospressPageIndexService.getInstance();
    this.pageIndexOrchestrator = NospressPageIndexOrchestrator.getInstance();
    this.menuService = NospressMenuService.getInstance();
    this.menuOrchestrator = NospressMenuOrchestrator.getInstance();

    try {
      const decoded = decodeNip19(npub);
      this.pubkey = decoded.type === 'npub'
        ? decoded.data as string
        : (decoded.data as { pubkey: string }).pubkey;
    } catch {
      this.pubkey = '';
    }

    // Read active slug from URL — `?page=<slug>` with empty / missing = home.
    const params = new URLSearchParams(window.location.search);
    const urlSlug = params.get('page') ?? HOME_SLUG;
    this.activeSlug = isValidSlug(urlSlug) ? urlSlug : HOME_SLUG;

    this.setupChangeListeners();
    this.setupEditDelegation();
    bindCssTextareaUx(this.container);
    this.loadAndRender();
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    const eventBus = EventBus.getInstance();
    this.eventBusSubscriptions.forEach(id => eventBus.off(id));
    this.eventBusSubscriptions = [];
    this.destroyInlineMounts();
    this.destroyFolderPickers();
    this.destroyBlockDropdowns();
    this.destroyCursorRow();
    this.destroyProfileCards();
    this.destroyArticlesCarousels();
    if (this.fullscreenOverlay) {
      this.fullscreenOverlay.unmount();
      this.fullscreenOverlay = null;
    }
    this.blockLibrary?.destroy();
    this.blockLibrary = null;
    removeUserCss();
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
    const eventBus = EventBus.getInstance();
    this.eventBusSubscriptions.push(
      eventBus.on('nospressList:changed', () => this.rerenderEditable())
    );
    this.eventBusSubscriptions.push(
      eventBus.on('nospressPageIndex:changed', () => this.updatePagesTab())
    );
    this.eventBusSubscriptions.push(
      eventBus.on('nospressMenus:changed', () => this.updateNavTab())
    );
  }

  private async loadAndRender(): Promise<void> {
    // Tear down inline-mount components before innerHTML wipes their DOM.
    this.destroyInlineMounts();

    this.container.innerHTML = `
      <div class="nospress-loading">
        <div class="loading-spinner"></div>
        <p>Loading page...</p>
      </div>
    `;

    try {
      // Own profile only — foreign profiles redirect in the constructor.
      // Pull the latest published state from relays so edits made on a
      // different instance show up here. publishedV2 is updated; renderList
      // still prefers draftV2 / editingPage so unsaved local work survives.
      // Fetch the page-index + menus first so the Pages and Nav tabs have
      // data; failures are non-fatal — empty index = single-page user, no
      // menus = primary navigation seeds locally from the page-index.
      const [remoteIndex, remoteMenus] = await Promise.all([
        this.pageIndexOrchestrator.fetchFromRelays(this.pubkey, true),
        this.menuOrchestrator.fetchFromRelays(this.pubkey, true),
      ]);
      if (remoteIndex) this.pageIndexService.setIndexFromRelay(remoteIndex);
      if (remoteMenus) this.menuService.setMenuSetFromRelay(remoteMenus);
      // Reconcile menus with whatever pages are now in the local index —
      // covers the case where pages were added/removed on another device.
      this.menuService.syncWithPages();

      const remote = await this.orchestrator.fetchFromRelays(this.pubkey, true, this.activeSlug);
      if (remote && remote.blocks.length > 0) {
        this.listService.savePublishedV2(remote, this.activeSlug);
      }

      await this.renderList();

      // Mount inline bookmark-folder content into the slots emitted by
      // BookmarkFolderRenderer's readonly path.
      await this.mountInlineBookmarkFolders();

      // NosPress is fullscreen-only — open the editor overlay automatically
      // after the first render so the user lands directly in the editor.
      if (!this.fullscreenOverlay) {
        this.enterFullscreenEditor();
      }
    } catch (error) {
      console.error('Failed to load NosPress:', error);
      this.container.innerHTML = '<p class="nospress-error">Failed to load page.</p>';
    }
  }

  private async renderList(): Promise<void> {
    // NosPress is owner-only in-app; foreign profiles redirect in the
    // constructor, so this view always renders the owner's editable page.
    const editSlug = this.currentEditSlug();
    const stored = this.listService.getDraftV2(editSlug)
      ?? this.listService.getPublishedV2(editSlug)
      ?? this.listService.getPageV2(editSlug);
    const page: NospressPageV2 = this.editingPage ?? stored;
    const editable = true;

    this.normalizeCursor(page);

    // Page-meta (title/subtitle/description) are no longer rendered as a fixed
    // top section — the user composes them via Heading + Text blocks like any
    // other page content. The fields remain in NospressPageV2 for backwards
    // compatibility when reading old v2 events; they are no-ops in the UI.
    const blocksHtml = editable
      ? this.renderBlocksWithCursor(page.blocks)
      : BlockRenderer.renderAll(page.blocks, { editable: false });

    // Tear down old picker / mount instances before innerHTML replaces their DOM
    this.destroyFolderPickers();
    this.destroyBlockDropdowns();
    this.destroyProfileCards();
    this.destroyArticlesCarousels();

    const pageSelected = this.selectedBlockId === PAGE_SELECTION_ID;
    // The editor is a schematic composer — we keep the same DOM structure
    // as PublicNospressPage (.user-site > .layout-wrapper > blocks) so the
    // user can mentally map their selectors to the published view, but we
    // do NOT emit the page-level inline style here. Live preview of styles
    // happens on the public page only.
    const pageContentHtml = `
      <div class="user-site">
        <div class="layout-wrapper nospress-page-content">${blocksHtml}</div>
      </div>
    `;

    const titleBarLabel = this.editingTarget === 'header'
      ? 'GLOBAL HEADER'
      : this.editingTarget === 'footer'
        ? 'GLOBAL FOOTER'
        : 'PAGE';
    const composedBlocksHtml = `
      <div class="nospress-page-edit${pageSelected ? ' nospress-page-edit--selected' : ''}" data-block-id="${PAGE_SELECTION_ID}">
        <div class="nospress-page-edit__title-bar">${titleBarLabel}</div>
        ${pageContentHtml}
      </div>
    `;

    const cssEditorHtml = this.cssEditorOpen ? this.renderCssEditorPanel(page) : '';

    const templateHeadingHtml = `<h2>${escapeHtml(this.computeTemplateHeading())}</h2>`;

    // No in-PCC header: the only edit surface is the FullscreenOverlay,
    // which provides its own header (title + Exit + extraActions like
    // See Website / CSS Editor toggle).
    this.container.innerHTML = `
      <div class="nospress-view">
        ${cssEditorHtml}
        ${templateHeadingHtml}
        ${composedBlocksHtml}
        ${this.renderActionBar(editable)}
      </div>
    `;

    this.mountFolderPickers();
    this.mountBlockDropdowns();
    this.mountCursorRow();
    this.applySelectedBlockClass();
    this.profileCardInstances = mountNospressProfileCards(this.container, { ownerPubkey: this.pubkey });
    this.articlesCarousels = mountNospressArticlesLists(this.container, { ownerPubkey: this.pubkey });
    mountNospressWeblogs(this.container, { ownerPubkey: this.pubkey });
    this.mountNavMenuPreviews();
  }

  /** Fill every nav-menu mount slot in the editor container with a real
   *  `<nav><ul><li><a>` preview, plus populate the menu-picker `<select>`s
   *  in editable mode with all available menu ids. */
  private mountNavMenuPreviews(): void {
    const menuSet = this.menuService.getMenuSet();
    const pageIndex = this.pageIndexService.getIndex();
    mountNospressNavMenus(this.container, {
      menuSet,
      pageIndex,
      ownerHandle: this.npub,
      currentSlug: this.activeSlug,
      editorPreview: true,
    });
    // Fill the menu-picker dropdowns with the full menu list (the renderer
    // can only emit the picked menuId by itself; we own the full set here).
    const selects = this.container.querySelectorAll<HTMLSelectElement>('.nospress-block-nav-menu__select');
    selects.forEach(sel => {
      const current = sel.value;
      sel.innerHTML = menuSet.menus.map(m =>
        `<option value="${escapeHtml(m.id)}"${m.id === current ? ' selected' : ''}>${escapeHtml(m.name)}</option>`
      ).join('');
    });
  }

  private destroyProfileCards(): void {
    this.profileCardInstances.forEach(ui => ui.destroy());
    this.profileCardInstances = [];
  }

  private destroyArticlesCarousels(): void {
    this.articlesCarousels.forEach(c => c.destroy());
    this.articlesCarousels = [];
  }

  private renderActionBar(editable: boolean): string {
    const isDirty = this.isDirty;
    const editSlug = this.currentEditSlug();
    const hasDraft = this.listService.hasDraftV2(editSlug);
    const hasPublished = this.listService.getPublishedV2(editSlug) !== null;
    const localButtons = editable
      ? `
        <button type="button" class="btn" data-action="save" ${isDirty ? '' : 'disabled'}>Save</button>
        <button type="button" class="btn btn--passive" data-action="discard" ${hasDraft ? '' : 'disabled'}>Discard</button>
      `
      : '';
    return `
      <div class="nospress-action-bar l-row--split">
        <div>
          <button type="button" class="btn" data-action="publish" ${(isDirty || hasDraft) ? '' : 'disabled'}>Publish</button>
          <button type="button" class="btn btn--passive btn--danger" data-action="delete-list" ${hasPublished ? '' : 'disabled'}>Unpublish</button>
        </div>
        <div>${localButtons}</div>
      </div>
    `;
  }

  /** Re-render only the action bar (used after save/dirty state changes). */
  private refreshActionBar(): void {
    const bar = this.container.querySelector('.nospress-action-bar');
    if (!bar) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = this.renderActionBar(this.editMode);
    const next = tmp.firstElementChild;
    if (next) bar.replaceWith(next);
  }

  /**
   * For each `<div class="nospress-bookmark-folder-mount" data-folder-name="…">`
   * slot emitted by `BookmarkFolderRenderer`'s readonly path, mount a
   * `ProfileListsComponent` rendering that single folder. The component's
   * `.profile-lists-mount` element is inserted directly after the slot, so
   * the folder content appears at the block's position in the page stream.
   */
  private async mountInlineBookmarkFolders(): Promise<void> {
    this.destroyInlineMounts();
    const slots = this.container.querySelectorAll<HTMLElement>('.nospress-bookmark-folder-mount');
    for (const slot of Array.from(slots)) {
      const folderName = slot.dataset.folderName;
      if (!folderName) continue;
      const component = new ProfileListsComponent(this.pubkey, 'nospress');
      this.inlineMountsComponents.push(component);
      // ProfileListsComponent.render inserts a `.profile-lists-mount` element
      // AFTER the given anchor — perfect for our slot-as-anchor use case.
      await component.render(slot, [folderName]);
    }
  }

  private destroyInlineMounts(): void {
    this.inlineMountsComponents.forEach(c => c.destroy());
    this.inlineMountsComponents = [];
  }


  private async confirmAndUnpublish(): Promise<void> {
    const confirmed = await ModalService.getInstance().confirm({
      title: 'Unpublish page',
      message: 'This removes the published page from your relays. Your local draft is kept so you can re-publish later.',
      confirmDestructive: true,
    });
    if (!confirmed) return;

    try {
      const editSlug = this.currentEditSlug();
      await this.orchestrator.deleteFromRelays(editSlug);
      this.listService.clearPublishedV2(editSlug);
      if (editSlug === HOME_SLUG) {
        this.listService.deleteList();
      }
      this.refreshActionBar();
      this.updatePagesTab();
      ToastService.show('Unpublished', 'success');
    } catch (error) {
      console.error('Failed to unpublish:', error);
      ToastService.show('Unpublish failed', 'error');
    }
  }

  /**
   * Mount the fullscreen editor — the only edit surface. Re-parents
   * `this.container` into the overlay's editor slot so the existing render
   * pipeline keeps writing to the same element. The 70/30 desktop split
   * shows the page on the left, the BlockLibrary on the right; phones
   * collapse to single-column with the slash menu doing block selection.
   */
  private enterFullscreenEditor(): void {
    if (this.fullscreenOverlay?.isMounted()) return;

    // Build the split body. Editor slot will host this.container; library slot
    // gets a fresh BlockLibraryView.
    const split = document.createElement('div');
    split.className = 'nospress-fullscreen-split';
    const editorSlot = document.createElement('div');
    editorSlot.className = 'nospress-fullscreen-split__editor';
    const librarySlot = document.createElement('div');
    librarySlot.className = 'nospress-fullscreen-split__library';
    split.appendChild(editorSlot);
    split.appendChild(librarySlot);
    this.fullscreenSplit = split;
    this.libraryHidden = false;

    // Remember where to put this.container back when we exit.
    this.fullscreenOriginParent = this.container.parentElement as HTMLElement | null;
    this.fullscreenOriginAnchor = this.container.nextSibling;
    editorSlot.appendChild(this.container);
    this.container.classList.add('nospress-view--fullscreen');

    this.blockLibrary = new BlockLibraryView({
      onApply: (type) => this.applyBlock(type),
      onSelectPage: () => this.selectBlock(this.selectedBlockId === PAGE_SELECTION_ID ? null : PAGE_SELECTION_ID),
      onSelectCss: () => this.toggleCssEditor(),
    });
    this.mountRightPane(librarySlot);

    this.rerenderEditable();

    // "See Website" → opens the public NosPress page in a new tab. URL
    // composes handle + the active page slug (empty = home). Initial form
    // uses the canonical npub (always works); async-upgraded to nip05 if
    // the profile has one. Slug is read live from `activeSlug` at click
    // time, so navigating between pages in the editor opens the right one.
    const seeWebsiteButton = document.createElement('button');
    seeWebsiteButton.type = 'button';
    seeWebsiteButton.className = 'btn btn--passive btn--medium';
    seeWebsiteButton.textContent = 'See Website';
    let seeWebsiteHandle = this.npub;
    seeWebsiteButton.addEventListener('click', () => {
      const slugPath = this.activeSlug && this.activeSlug !== HOME_SLUG
        ? `${encodeURIComponent(this.activeSlug)}/`
        : '';
      const url = `https://noornote.app/${seeWebsiteHandle}/${slugPath}`;
      window.open(url, '_blank', 'noopener,noreferrer');
    });
    UserProfileService.getInstance().getUserProfile(this.pubkey).then(profile => {
      const nip05 = profile?.nip05?.trim();
      if (nip05) seeWebsiteHandle = nip05;
    }).catch(() => { /* keep npub fallback */ });

    // CSS Editor toggle — opens the Custom-CSS textarea panel inside the
    // editor body. Same target as the Block Library "Custom CSS" card.
    const cssEditorButton = document.createElement('button');
    cssEditorButton.type = 'button';
    cssEditorButton.className = 'btn btn--passive btn--medium';
    cssEditorButton.textContent = 'CSS Editor';
    cssEditorButton.addEventListener('click', () => this.toggleCssEditor());

    // Library-toggle — collapses the right pane so the editor takes the
    // full width when the user wants more room to compose.
    const libraryToggleBtn = document.createElement('button');
    libraryToggleBtn.type = 'button';
    libraryToggleBtn.className = 'btn btn--passive btn--medium';
    libraryToggleBtn.textContent = 'Hide Library';
    libraryToggleBtn.addEventListener('click', () => this.toggleLibraryHidden());
    this.libraryToggleBtn = libraryToggleBtn;

    this.fullscreenOverlay = new FullscreenOverlay({
      title: 'Edit NosPress Site',
      exitLabel: 'Exit NosPress',
      body: split,
      maxWidth: '100%',
      extraActions: [seeWebsiteButton, cssEditorButton, libraryToggleBtn],
      onExit: () => this.cleanupFullscreenEditor(),
    });
    this.fullscreenOverlay.mount();
  }

  /**
   * Build the tab-area UI inside the right pane (Blocks + Properties).
   * Same `tabs` / `tab-content` markup pattern as the SCC so the existing
   * NoorNote tab styling applies. Initial active tab: Blocks. Properties
   * tab updates lazily when the user selects a block.
   */
  private mountRightPane(librarySlot: HTMLElement): void {
    const tabBar = document.createElement('div');
    tabBar.className = 'tabs nospress-tabs';
    tabBar.innerHTML = `
      <button type="button" class="tab tab--active" data-tab="pages"><span class="tab__label">Pages</span></button>
      <button type="button" class="tab" data-tab="blocks"><span class="tab__label">Blocks</span></button>
      <button type="button" class="tab" data-tab="properties"><span class="tab__label">Properties</span></button>
      <button type="button" class="tab" data-tab="nav"><span class="tab__label">Nav</span></button>
    `;

    const pagesContent = document.createElement('div');
    pagesContent.className = 'tab-content tab-content--active';
    pagesContent.dataset.tabContent = 'pages';
    pagesContent.innerHTML = this.renderPagesContent();

    const blocksContent = document.createElement('div');
    blocksContent.className = 'tab-content';
    blocksContent.dataset.tabContent = 'blocks';
    if (this.blockLibrary) blocksContent.appendChild(this.blockLibrary.getElement());

    const propertiesContent = document.createElement('div');
    propertiesContent.className = 'tab-content';
    propertiesContent.dataset.tabContent = 'properties';
    propertiesContent.innerHTML = this.renderPropertiesContent();

    const navContent = document.createElement('div');
    navContent.className = 'tab-content';
    navContent.dataset.tabContent = 'nav';
    navContent.innerHTML = this.renderNavContent();

    librarySlot.appendChild(tabBar);
    librarySlot.appendChild(pagesContent);
    librarySlot.appendChild(blocksContent);
    librarySlot.appendChild(propertiesContent);
    librarySlot.appendChild(navContent);

    setupTabClickHandlers(librarySlot, (tabId) => switchTabWithContent(librarySlot, tabId));

    // Style/Attr inputs in the Properties tab live OUTSIDE this.container,
    // so the editor's input-delegation never sees them. Mirror the relevant
    // dispatch on the right pane.
    const propsHandler = (e: Event) => {
      const target = e.target as HTMLInputElement;
      const styleScope = target.dataset?.styleScope;
      const styleField = target.dataset?.styleField;
      if (styleScope && styleField) this.handleStyleInput(styleScope, styleField, target.value);

      const attrScope = target.dataset?.attrScope;
      const attrField = target.dataset?.attrField;
      if (attrScope && attrField) this.handleAttrInput(attrScope, attrField, target.value);
    };
    librarySlot.addEventListener('input', propsHandler);
    librarySlot.addEventListener('change', propsHandler);

    pagesContent.addEventListener('click', (e) => this.handlePagesTabClick(e));
    pagesContent.addEventListener('keydown', (e) => this.handleInlineRenameKeydown(e));
    pagesContent.addEventListener('focusout', (e) => this.handleInlineRenameFocusout(e));

    navContent.addEventListener('click', (e) => this.handleNavTabClick(e));
    navContent.addEventListener('change', (e) => this.handleNavTabChange(e));
    navContent.addEventListener('submit', (e) => this.handleNavTabSubmit(e));

    this.rightPaneEl = librarySlot;
    this.propertiesTabContent = propertiesContent;
    this.pagesTabContent = pagesContent;
    this.navTabContent = navContent;
    this.attachNavDragHandlers();
  }

  /**
   * Render the Pages tab body. Each tile has a `.nn-card` (with 3 stacked
   * Header / Body / Footer sections inside) plus a title + meta below the
   * card itself. Order:
   *   1. Default Website Template tile (Slice 2 hooks Header/Body/Footer)
   *   2. One tile per page in the index
   *   3. "Add new page" tile — dashed, click opens the new-page prompt
   */
  private renderPagesContent(): string {
    const index = this.pageIndexService.getIndex();
    const pageTiles = index.pages.map(p => this.renderPageTile(p)).join('');
    return `
      <div class="nospress-pages">
        <div class="nospress-pages__grid">
          ${this.renderDefaultTemplateTile()}
          ${pageTiles}
          ${this.renderAddPageTile()}
        </div>
      </div>
    `;
  }

  /**
   * "Default Website Template" tile — 3 dashed placeholder sections inside
   * the card; title + meta sit below the card on the tab background. Slice 2
   * activates the rows by wiring them to `noornote/header` + `noornote/footer`.
   */
  private renderDefaultTemplateTile(): string {
    const headerActive = this.editingTarget === 'header';
    const footerActive = this.editingTarget === 'footer';
    const headerHasContent = this.hasGlobalContent(GLOBAL_HEADER_SLUG);
    const footerHasContent = this.hasGlobalContent(GLOBAL_FOOTER_SLUG);

    const headerCls = this.globalSectionClass(headerHasContent, headerActive);
    const footerCls = this.globalSectionClass(footerHasContent, footerActive);
    const headerLabel = headerHasContent ? 'Global Header' : '+ Add Global Header';
    const footerLabel = footerHasContent ? 'Global Footer' : '+ Add Global Footer';

    return `
      <div class="nospress-pages__item" data-template-default>
        <h3 class="nospress-pages__title">Header &amp; Footer</h3>
        <div class="nn-card" data-page-template data-template-default>
          <div class="nn-card__content">
            <div class="nospress-pages__sections">
              <div class="${headerCls}" data-action="select-global-header">
                <span class="nospress-pages__section-label">${escapeHtml(headerLabel)}</span>
              </div>
              <div class="nospress-pages__section nospress-pages__section--placeholder" data-disabled>
                <span class="nospress-pages__section-label"></span>
              </div>
              <div class="${footerCls}" data-action="select-global-footer">
                <span class="nospress-pages__section-label">${escapeHtml(footerLabel)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  /** Has the given global slug ('__header'/'__footer') been saved with at
   *  least one block? Reads draft → published; both are local-first. */
  private hasGlobalContent(slug: string): boolean {
    return this.listService.hasV2Content(slug);
  }

  /** CSS class for the Header / Footer section pill on the H&F card.
   *   - active = pink ($color-4)
   *   - has content = green ($color-6)
   *   - empty = dashed placeholder */
  private globalSectionClass(hasContent: boolean, isActive: boolean): string {
    if (isActive) return 'nospress-pages__section nospress-pages__section--active';
    if (hasContent) return 'nospress-pages__section nospress-pages__section--global-filled';
    return 'nospress-pages__section nospress-pages__section--placeholder';
  }

  /** Page tile: card with 3 sections (Global Header inherited, Custom Body
   *  per page, Global Footer inherited) + title + action buttons below.
   *  Header/Footer pills inherit their color from the global state — green
   *  when the H&F card has saved content, dashed placeholder otherwise. */
  private renderPageTile(entry: PageIndexEntry): string {
    const isActiveSlug = entry.slug === this.activeSlug;
    const isActive = isActiveSlug && this.editingTarget === 'body';
    const isHome = entry.slug === HOME_SLUG;
    const bodyClass = isActive
      ? 'nospress-pages__section nospress-pages__section--active'
      : 'nospress-pages__section nospress-pages__section--filled';
    const headerHasContent = this.hasGlobalContent(GLOBAL_HEADER_SLUG);
    const footerHasContent = this.hasGlobalContent(GLOBAL_FOOTER_SLUG);
    const headerCls = headerHasContent
      ? 'nospress-pages__section nospress-pages__section--global-filled'
      : 'nospress-pages__section nospress-pages__section--placeholder';
    const footerCls = footerHasContent
      ? 'nospress-pages__section nospress-pages__section--global-filled'
      : 'nospress-pages__section nospress-pages__section--placeholder';
    return `
      <div class="nospress-pages__item" data-page-slug="${escapeHtml(entry.slug)}" ${isActive ? 'data-active="true"' : ''}>
        <h3
          class="nospress-pages__title nospress-pages__title--editable"
          contenteditable="true"
          spellcheck="false"
          data-inline-rename
          data-page-slug="${escapeHtml(entry.slug)}"
          data-original-title="${escapeHtml(entry.title)}"
        >${escapeHtml(entry.title)}</h3>
        <div class="nn-card" data-page-template>
          <div class="nn-card__content">
            <div class="nospress-pages__sections">
              <div class="${headerCls}" data-disabled>
                <span class="nospress-pages__section-label">Global Header</span>
              </div>
              <div class="${bodyClass}" data-action="switch-page" data-page-slug="${escapeHtml(entry.slug)}">
                <span class="nospress-pages__section-label">Custom Body</span>
              </div>
              <div class="${footerCls}" data-disabled>
                <span class="nospress-pages__section-label">Global Footer</span>
              </div>
            </div>
          </div>
        </div>
        ${isHome ? '' : `
          <div class="nospress-pages__card-actions">
            <button type="button" class="btn btn--passive btn--mini" data-action="delete-page" data-page-slug="${escapeHtml(entry.slug)}">Delete</button>
          </div>
        `}
      </div>
    `;
  }

  /** Last tile — full-card dashed placeholder. Click triggers the new-page
   *  prompt. No sections inside; just centered "+ Add new page". */
  private renderAddPageTile(): string {
    return `
      <div class="nospress-pages__item" data-add-page>
        <div
          class="nn-card nospress-pages__add-card"
          data-page-template
          data-action="new-page"
          role="button"
          tabindex="0"
        >
          <div class="nn-card__content">
            <span class="nospress-pages__add-label">+ Add new page</span>
          </div>
        </div>
      </div>
    `;
  }

  /** Re-render the Pages tab body. Called on page-index changes (incl. CRUD)
   *  and after activeSlug changes. */
  private updatePagesTab(): void {
    if (this.pagesTabContent) {
      this.pagesTabContent.innerHTML = this.renderPagesContent();
    }
  }

  /**
   * Render the Nav tab body. One section per menu; Primary Navigation
   * comes first. Each menu shows its items with up/down/remove controls
   * and a "+ Add page" picker for any pages not yet in the menu.
   *
   * Multiple menus + external URL items come in Slice 2.4 — for now the
   * Add menu UI is hidden.
   */
  private renderNavContent(): string {
    const set = this.menuService.getMenuSet();
    const orderedMenus = [...set.menus].sort((a, b) => {
      if (a.id === PRIMARY_MENU_ID) return -1;
      if (b.id === PRIMARY_MENU_ID) return 1;
      return 0;
    });
    const sections = orderedMenus.map(menu => this.renderMenuTile(menu)).join('');
    return `
      <div class="nospress-nav">
        ${sections}
        <div class="nospress-nav__add-menu">
          <button type="button" class="btn btn--passive btn--mini" data-action="add-menu">+ Add menu</button>
        </div>
      </div>
    `;
  }

  private renderMenuTile(menu: NospressMenu): string {
    const isPrimary = menu.id === PRIMARY_MENU_ID;
    const itemsHtml = menu.items.length > 0
      ? menu.items.map((item, i) => this.renderMenuItemRow(menu, item, i)).join('')
      : `<p class="nospress-nav__empty">No items yet.</p>`;

    const usedSlugs = new Set(
      menu.items.filter(i => i.type === 'page').map(i => (i as Extract<NavItem, { type: 'page' }>).pageSlug)
    );
    const availablePages = this.pageIndexService.getIndex().pages.filter(p => !usedSlugs.has(p.slug));
    const pageOptions = availablePages.length > 0
      ? availablePages.map(p => `<option value="${escapeHtml(p.slug)}">${escapeHtml(p.title)}</option>`).join('')
      : '';

    const addPagePickerHtml = availablePages.length > 0
      ? `
        <select class="nospress-nav__add-select" data-menu-id="${escapeHtml(menu.id)}">
          <option value="">+ Add page…</option>
          ${pageOptions}
        </select>
      `
      : '';

    const addUrlButtonHtml = `
      <button type="button" class="btn btn--passive btn--mini" data-action="add-url-toggle" data-menu-id="${escapeHtml(menu.id)}">+ Add URL</button>
    `;

    const addUrlFormHtml = `
      <form class="nospress-nav__url-form" data-menu-id="${escapeHtml(menu.id)}" hidden>
        <input type="text" class="nospress-nav__url-input" data-field="label" placeholder="Label (e.g. Twitter)" />
        <input type="url" class="nospress-nav__url-input" data-field="url" placeholder="https://example.com" />
        <button type="submit" class="btn btn--mini">Add</button>
      </form>
    `;

    const menuActionsHtml = isPrimary ? '' : `
      <span class="nospress-nav__menu-actions">
        <button type="button" class="btn btn--passive btn--mini" data-action="menu-rename" data-menu-id="${escapeHtml(menu.id)}">Rename</button>
        <button type="button" class="btn btn--passive btn--mini" data-action="menu-delete" data-menu-id="${escapeHtml(menu.id)}">Delete</button>
      </span>
    `;

    return `
      <section class="nospress-nav__menu" data-menu-id="${escapeHtml(menu.id)}">
        <header class="nospress-nav__menu-header">
          <h3 class="nospress-nav__title">${escapeHtml(menu.name)}</h3>
          ${menuActionsHtml}
        </header>
        <ol class="nospress-nav__items" data-menu-id="${escapeHtml(menu.id)}">${itemsHtml}</ol>
        <div class="nospress-nav__add">
          ${addPagePickerHtml}
          ${addUrlButtonHtml}
        </div>
        ${addUrlFormHtml}
      </section>
    `;
  }

  private renderMenuItemRow(menu: NospressMenu, item: NavItem, index: number): string {
    const total = menu.items.length;
    const upDisabled = index === 0 ? 'disabled' : '';
    const downDisabled = index === total - 1 ? 'disabled' : '';

    const label = (() => {
      if (item.type === 'page') {
        const entry = this.pageIndexService.getEntry(item.pageSlug);
        return entry ? entry.title : `(missing: ${item.pageSlug})`;
      }
      return item.label || item.url;
    })();
    const sub = item.type === 'url' ? `<span class="nospress-nav__item-sub">${escapeHtml(item.url)}</span>` : '';

    return `
      <li class="nospress-nav__item" data-menu-id="${escapeHtml(menu.id)}" data-item-index="${index}">
        <span class="nospress-nav__item-label">${escapeHtml(label)}${sub}</span>
        <span class="nospress-nav__item-actions">
          <button type="button" class="btn btn--passive btn--mini" data-action="menu-item-up" data-menu-id="${escapeHtml(menu.id)}" data-item-index="${index}" ${upDisabled}>↑</button>
          <button type="button" class="btn btn--passive btn--mini" data-action="menu-item-down" data-menu-id="${escapeHtml(menu.id)}" data-item-index="${index}" ${downDisabled}>↓</button>
          <button type="button" class="btn btn--passive btn--mini" data-action="menu-item-remove" data-menu-id="${escapeHtml(menu.id)}" data-item-index="${index}">×</button>
        </span>
      </li>
    `;
  }

  private updateNavTab(): void {
    if (this.navTabContent) {
      this.navTabContent.innerHTML = this.renderNavContent();
      this.attachNavDragHandlers();
    }
  }

  /** Wire drag-and-drop reorder on every menu's `<ol>` after the Nav tab
   *  body is (re-)rendered. Mouse-only — the up/down buttons stay as the
   *  touch-friendly fallback. */
  private attachNavDragHandlers(): void {
    if (!this.navTabContent) return;
    this.navTabContent.querySelectorAll<HTMLElement>('.nospress-nav__items').forEach(grid => {
      const menuId = grid.dataset.menuId ?? '';
      if (!menuId) return;
      setupGridDragDrop(grid, {
        itemSelector: '.nospress-nav__item',
        excludeSelector: 'button, .nospress-nav__item-actions',
        placeholderClass: 'nospress-nav__item-placeholder',
        getItemId: el => el.dataset.itemIndex ?? null,
        onDrop: (draggedIdStr, _draggedEl, dropTarget) => {
          const fromIndex = parseInt(draggedIdStr, 10);
          const toIndex = parseInt(dropTarget.dataset.itemIndex ?? '-1', 10);
          if (isNaN(fromIndex) || isNaN(toIndex) || fromIndex === toIndex) return;
          void this.commitMenuChange(() => this.menuService.moveMenuItem(menuId, fromIndex, toIndex));
        },
      });
    });
  }

  private handleNavTabClick(e: Event): void {
    const target = e.target as HTMLElement;
    const select = target.closest('.nospress-nav__add-select') as HTMLSelectElement | null;
    // Add picker is `change`-driven, not click. Bail out if a menu's <select>
    // is the click target — let the change handler (below) deal with it.
    if (select) return;

    const actionEl = target.closest('[data-action]') as HTMLElement | null;
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    const menuId = actionEl.dataset.menuId ?? '';
    const indexStr = actionEl.dataset.itemIndex;
    const index = indexStr !== undefined ? parseInt(indexStr, 10) : -1;

    if (action === 'menu-item-up' && index > 0) {
      void this.commitMenuChange(() => this.menuService.moveMenuItem(menuId, index, index - 1));
      return;
    }
    if (action === 'menu-item-down' && index >= 0) {
      void this.commitMenuChange(() => this.menuService.moveMenuItem(menuId, index, index + 1));
      return;
    }
    if (action === 'menu-item-remove' && index >= 0) {
      void this.commitMenuChange(() => this.menuService.removeMenuItem(menuId, index));
      return;
    }
    if (action === 'add-url-toggle') {
      this.toggleAddUrlForm(menuId);
      return;
    }
    if (action === 'add-menu') {
      void this.createNewMenu();
      return;
    }
    if (action === 'menu-rename') {
      void this.renameMenu(menuId);
      return;
    }
    if (action === 'menu-delete') {
      void this.deleteMenu(menuId);
      return;
    }
  }

  /** Show/hide the inline URL-form for a given menu. Other forms close so
   *  only one is open at a time. */
  private toggleAddUrlForm(menuId: string): void {
    if (!this.navTabContent) return;
    const allForms = this.navTabContent.querySelectorAll<HTMLFormElement>('.nospress-nav__url-form');
    allForms.forEach(f => {
      const isMatch = f.dataset.menuId === menuId;
      if (isMatch) {
        f.hidden = !f.hidden;
        if (!f.hidden) f.querySelector<HTMLInputElement>('[data-field="label"]')?.focus();
      } else {
        f.hidden = true;
      }
    });
  }

  private handleNavTabSubmit(e: Event): void {
    const form = (e.target as HTMLElement).closest('.nospress-nav__url-form') as HTMLFormElement | null;
    if (!form) return;
    e.preventDefault();
    const menuId = form.dataset.menuId ?? '';
    const labelInput = form.querySelector<HTMLInputElement>('[data-field="label"]');
    const urlInput = form.querySelector<HTMLInputElement>('[data-field="url"]');
    const label = labelInput?.value.trim() ?? '';
    const url = urlInput?.value.trim() ?? '';
    if (!menuId || !label || !url) return;

    void this.commitMenuChange(() =>
      this.menuService.appendMenuItem(menuId, { type: 'url', label, url })
    );
  }

  private async createNewMenu(): Promise<void> {
    const name = await ModalService.getInstance().prompt({
      title: 'New menu',
      message: 'Menu name (e.g. "Footer Menu"):',
      placeholder: 'Footer Menu',
    });
    if (!name) return;
    const id = this.uniqueMenuId(this.slugifyMenuId(name));
    void this.commitMenuChange(() => this.menuService.addMenu({ id, name, items: [] }));
  }

  private slugifyMenuId(input: string): string {
    return input.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'menu';
  }

  private uniqueMenuId(base: string): string {
    const set = this.menuService.getMenuSet();
    const taken = new Set(set.menus.map(m => m.id));
    if (!taken.has(base)) return base;
    let i = 2;
    while (taken.has(`${base}-${i}`)) i++;
    return `${base}-${i}`;
  }

  private async renameMenu(menuId: string): Promise<void> {
    const menu = this.menuService.getMenu(menuId);
    if (!menu) return;
    const name = await ModalService.getInstance().prompt({
      title: 'Rename menu',
      message: 'New name:',
      defaultValue: menu.name,
    });
    if (!name || name === menu.name) return;
    void this.commitMenuChange(() => this.menuService.renameMenu(menuId, name));
  }

  private async deleteMenu(menuId: string): Promise<void> {
    if (menuId === PRIMARY_MENU_ID) return;
    const menu = this.menuService.getMenu(menuId);
    if (!menu) return;
    const confirmed = await ModalService.getInstance().confirm({
      title: 'Delete menu',
      message: `Delete "${menu.name}"? This removes the menu from your relays. Cannot be undone.`,
      confirmDestructive: true,
    });
    if (!confirmed) return;
    void this.commitMenuChange(() => this.menuService.removeMenu(menuId));
  }

  /** Handle the "+ Add page…" picker on each menu tile. */
  private handleNavTabChange(e: Event): void {
    const target = e.target as HTMLElement;
    const select = target.closest('.nospress-nav__add-select') as HTMLSelectElement | null;
    if (!select) return;

    const slug = select.value;
    const menuId = select.dataset.menuId ?? '';
    if (!menuId) return;
    select.value = '';
    if (slug === '') return;

    void this.commitMenuChange(() =>
      this.menuService.appendMenuItem(menuId, { type: 'page', pageSlug: slug })
    );
  }

  /** Persist a menu change locally + publish to relays. The local mutation
   *  fires `nospressMenus:changed`, which re-renders the Nav tab. */
  private async commitMenuChange(mutate: () => void): Promise<void> {
    try {
      mutate();
      await this.menuOrchestrator.publishToRelays(this.menuService.getMenuSet());
    } catch (error) {
      console.error('Failed to update menu:', error);
      ToastService.show('Menu update failed', 'error');
    }
  }

  /** Heading text shown above the editor body — reflects which template
   *  slot is currently being edited. */
  private computeTemplateHeading(): string {
    if (this.editingTarget === 'header') return 'Template: Global Header';
    if (this.editingTarget === 'footer') return 'Template: Global Footer';
    const entry = this.pageIndexService.getEntry(this.activeSlug);
    const pageTitle = entry?.title ?? 'Home';
    return `Template: ${pageTitle} - Custom Body`;
  }

  /** The slug under which the currently-edited content is stored. For 'body'
   *  this is the active page slug; for 'header'/'footer' it's the reserved
   *  global slug. Storage and orchestrator calls use this — `activeSlug` is
   *  reserved for the page being edited as body. */
  private currentEditSlug(): string {
    if (this.editingTarget === 'header') return GLOBAL_HEADER_SLUG;
    if (this.editingTarget === 'footer') return GLOBAL_FOOTER_SLUG;
    return this.activeSlug;
  }

  /** Switch which template slot the editor is editing. Persists the current
   *  draft for the previous target before flipping, so unsaved edits survive
   *  the switch. */
  private selectEditingTarget(target: 'body' | 'header' | 'footer'): void {
    if (this.editingTarget === target) return;

    // Persist current in-memory edits to the slug we're leaving.
    if (this.editingPage && this.isDirty) {
      this.listService.saveDraftV2(this.editingPage, { silent: true, slug: this.currentEditSlug() });
    }

    this.editingTarget = target;
    this.editingPage = null;
    this.isDirty = false;
    this.selectedBlockId = null;
    this.cursor = { scope: 'page', index: -1 };

    this.rerenderEditable();
    this.updatePagesTab();
    this.updatePropertiesTab();
  }

  private handlePagesTabClick(e: Event): void {
    const target = e.target as HTMLElement;
    const actionEl = target.closest('[data-action]') as HTMLElement | null;
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    const slug = actionEl.dataset.pageSlug ?? '';

    if (action === 'new-page') {
      void this.createNewPage();
      return;
    }
    if (action === 'switch-page') {
      void this.switchToPage(slug);
      return;
    }
    if (action === 'rename-page') {
      void this.renameActivePage(slug);
      return;
    }
    if (action === 'delete-page') {
      void this.deletePageBySlug(slug);
      return;
    }
    if (action === 'select-global-header') {
      this.selectEditingTarget('header');
      return;
    }
    if (action === 'select-global-footer') {
      this.selectEditingTarget('footer');
      return;
    }
  }

  /**
   * Create a new page. Prompts the user for a title; derives a unique slug
   * from it. Persists locally and publishes the updated page-index to relays.
   * Switches to the new page on success.
   */
  private async createNewPage(): Promise<void> {
    const title = await ModalService.getInstance().prompt({
      title: 'New page',
      message: 'Page title (e.g. "About", "Projects"):',
      placeholder: 'About',
    });
    if (!title || !title.trim()) return;

    const baseSlug = normalizeSlug(title);
    if (!baseSlug) {
      ToastService.show('Invalid title — pick something with letters or numbers', 'error');
      return;
    }
    const slug = this.uniqueSlug(baseSlug);

    try {
      this.pageIndexService.addPage({ slug, title: title.trim() });
      await this.pageIndexOrchestrator.publishToRelays(this.pageIndexService.getIndex());
      await this.syncMenusAndPublish();
      await this.switchToPage(slug);
      ToastService.show(`Page "${title.trim()}" created`, 'success');
    } catch (error) {
      console.error('Failed to create page:', error);
      ToastService.show('Failed to create page', 'error');
    }
  }

  /** Reconcile menus with the current page index and publish to relays.
   *  Best-effort — local sync always succeeds; relay publish failures
   *  surface as a console warning so the local UI stays consistent. */
  private async syncMenusAndPublish(): Promise<void> {
    this.menuService.syncWithPages();
    try {
      await this.menuOrchestrator.publishToRelays(this.menuService.getMenuSet());
    } catch (err) {
      console.warn('Failed to publish menu set after page change', err);
    }
  }

  private uniqueSlug(base: string): string {
    if (!this.pageIndexService.hasSlug(base)) return base;
    let i = 2;
    while (this.pageIndexService.hasSlug(`${base}-${i}`)) i++;
    return `${base}-${i}`;
  }

  /**
   * Switch the editor to a different page. Persists the current draft
   * silently before switching, resets per-page editor state (cursor,
   * selection, dirty flag), updates the URL, and re-renders.
   */
  private async switchToPage(slug: string): Promise<void> {
    if (slug === this.activeSlug && this.editingTarget === 'body') return;
    if (!this.pageIndexService.hasSlug(slug)) {
      ToastService.show('Page not found', 'error');
      return;
    }

    // Persist any in-memory edits to the current slug so they survive the switch.
    if (this.editingPage && this.isDirty) {
      this.listService.saveDraftV2(this.editingPage, { silent: true, slug: this.activeSlug });
    }

    this.activeSlug = slug;
    this.editingTarget = 'body';
    this.editingPage = null;
    this.isDirty = false;
    this.selectedBlockId = null;
    this.cursor = { scope: 'page', index: -1 };

    // Reflect the active slug in the URL so a reload returns to the same page.
    const url = new URL(window.location.href);
    if (slug === HOME_SLUG) url.searchParams.delete('page');
    else url.searchParams.set('page', slug);
    window.history.replaceState(null, '', url.toString());

    // Pull the latest published state for the new slug; absent = empty page.
    try {
      const remote = await this.orchestrator.fetchFromRelays(this.pubkey, true, slug);
      if (remote && remote.blocks.length > 0) {
        this.listService.savePublishedV2(remote, slug);
      }
    } catch {
      // Non-fatal — local fallbacks render an empty page.
    }

    this.rerenderEditable();
    this.updatePagesTab();
    this.updatePropertiesTab();
  }

  private async renameActivePage(slug: string): Promise<void> {
    const entry = this.pageIndexService.getEntry(slug);
    if (!entry) return;
    const newTitle = await ModalService.getInstance().prompt({
      title: 'Rename page',
      message: 'New title:',
      defaultValue: entry.title,
    });
    if (!newTitle || !newTitle.trim() || newTitle.trim() === entry.title) return;
    await this.commitPageRename(slug, newTitle.trim());
  }

  /** Save+publish a page rename. Shared by the prompt-based Rename button
   *  and the inline-editable Home title. */
  private async commitPageRename(slug: string, newTitle: string): Promise<void> {
    try {
      this.pageIndexService.renamePage(slug, newTitle);
      await this.pageIndexOrchestrator.publishToRelays(this.pageIndexService.getIndex());
      this.updatePagesTab();
      ToastService.show('Page renamed', 'success');
    } catch (error) {
      console.error('Failed to rename page:', error);
      ToastService.show('Rename failed', 'error');
    }
  }

  /** Enter commits, Escape reverts. Both blur the contenteditable so the
   *  focusout handler runs (or doesn't, if Escape already restored text). */
  private handleInlineRenameKeydown(e: Event): void {
    const ke = e as KeyboardEvent;
    const target = ke.target as HTMLElement;
    if (!target?.matches?.('[data-inline-rename]')) return;

    if (ke.key === 'Enter') {
      ke.preventDefault();
      target.blur();
      return;
    }
    if (ke.key === 'Escape') {
      ke.preventDefault();
      const original = target.dataset.originalTitle ?? '';
      target.textContent = original;
      target.blur();
    }
  }

  /** Commit on focus loss when the title actually changed. Empty input or
   *  unchanged text reverts silently. */
  private handleInlineRenameFocusout(e: Event): void {
    const target = e.target as HTMLElement;
    if (!target?.matches?.('[data-inline-rename]')) return;

    const slug = target.dataset.pageSlug ?? '';
    const original = target.dataset.originalTitle ?? '';
    const next = (target.textContent ?? '').trim();

    if (!next || next === original) {
      target.textContent = original;
      return;
    }
    void this.commitPageRename(slug, next);
  }

  private async deletePageBySlug(slug: string): Promise<void> {
    if (slug === HOME_SLUG) return;
    const entry = this.pageIndexService.getEntry(slug);
    if (!entry) return;

    const confirmed = await ModalService.getInstance().confirm({
      title: 'Delete page',
      message: `Delete "${entry.title}"? This removes the page from your relays. Cannot be undone.`,
      confirmDestructive: true,
    });
    if (!confirmed) return;

    try {
      // 1) Remove the published event from relays (best-effort).
      try {
        await this.orchestrator.deleteFromRelays(slug);
      } catch (err) {
        console.warn('Failed to publish NIP-09 deletion for page', slug, err);
      }

      // 2) Drop local copies for this slug.
      this.listService.clearDraftV2(slug);
      this.listService.clearPublishedV2(slug);

      // 3) Update the index + republish.
      this.pageIndexService.removePage(slug);
      await this.pageIndexOrchestrator.publishToRelays(this.pageIndexService.getIndex());
      await this.syncMenusAndPublish();

      // 4) If we deleted the page we were editing, fall back to home.
      if (this.activeSlug === slug) {
        await this.switchToPage(HOME_SLUG);
      } else {
        this.updatePagesTab();
      }
      ToastService.show(`Page "${entry.title}" deleted`, 'success');
    } catch (error) {
      console.error('Failed to delete page:', error);
      ToastService.show('Delete failed', 'error');
    }
  }

  /**
   * Build the HTML for the Properties tab body. Empty placeholder when no
   * selection; page-properties panel when the page frame is selected;
   * block-properties panel for an individual block.
   */
  private renderPropertiesContent(): string {
    if (!this.selectedBlockId) {
      return `<p class="nospress-properties-empty">Select a block or the page frame to edit properties.</p>`;
    }
    if (this.selectedBlockId === PAGE_SELECTION_ID) {
      return this.renderInlinePageProperties();
    }
    const editSlug = this.currentEditSlug();
    const page = this.editingPage
      ?? this.listService.getDraftV2(editSlug)
      ?? this.listService.getPublishedV2(editSlug)
      ?? this.listService.getPageV2(editSlug);
    const loc = findBlockInPage(page, this.selectedBlockId);
    if (!loc) {
      return `<p class="nospress-properties-empty">Block not found.</p>`;
    }
    return this.renderInlineProperties(loc.block);
  }

  /**
   * Re-render the Properties tab body and (when something is selected)
   * auto-switch the right pane to the Properties tab so the user gets
   * immediate feedback after clicking a block.
   */
  private updatePropertiesTab(): void {
    if (this.propertiesTabContent) {
      this.propertiesTabContent.innerHTML = this.renderPropertiesContent();
    }
    if (this.selectedBlockId && this.rightPaneEl) {
      switchTabWithContent(this.rightPaneEl, 'properties');
    }
  }

  /** Collapse / restore the right-hand Block Library pane. Pure CSS toggle —
   *  the library element stays in the DOM so re-showing is instant. */
  private toggleLibraryHidden(): void {
    if (!this.fullscreenSplit) return;
    this.libraryHidden = !this.libraryHidden;
    this.fullscreenSplit.classList.toggle('nospress-fullscreen-split--no-library', this.libraryHidden);
    if (this.libraryToggleBtn) {
      this.libraryToggleBtn.textContent = this.libraryHidden ? 'Show Library' : 'Hide Library';
    }
  }

  /**
   * "Exit NosPress" handler — re-parents this.container so ViewMountingService
   * finds it in the expected place during teardown, then navigates back to
   * the addon settings page (the only NosPress entry point in-app).
   */
  private cleanupFullscreenEditor(): void {
    this.container.classList.remove('nospress-view--fullscreen');

    if (this.fullscreenOriginParent) {
      if (this.fullscreenOriginAnchor && this.fullscreenOriginAnchor.parentNode === this.fullscreenOriginParent) {
        this.fullscreenOriginParent.insertBefore(this.container, this.fullscreenOriginAnchor);
      } else {
        this.fullscreenOriginParent.appendChild(this.container);
      }
    }
    this.fullscreenOriginParent = null;
    this.fullscreenOriginAnchor = null;

    this.blockLibrary?.destroy();
    this.blockLibrary = null;
    this.fullscreenOverlay = null;
    this.fullscreenSplit = null;
    this.libraryToggleBtn = null;
    this.libraryHidden = false;
    this.rightPaneEl = null;
    this.propertiesTabContent = null;

    Router.getInstance().navigate('/addons/nospress');
  }

  /**
   * Apply a block from the Library: append to the current draft (or seed
   * a new draft from the migrated v1 page) and persist locally as v2.
   * The 'nospressDraftV2:changed' event triggers NospressView re-render.
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
    // For text blocks created from cursor-row typing, seed the content
    if (opts.initialContent !== undefined && block.type === 'text') {
      block.content = opts.initialContent;
    }

    const cur = this.cursor;

    // No nesting restrictions — div and columns can live in any container,
    // at any depth. findBlockInPage walks recursively so cursor / mutation
    // resolves the right array regardless of where the container sits.

    this.mutateDraft((page) => {
      if (cur.scope === 'page') {
        const insertIndex = Math.max(0, Math.min(cur.index < 0 ? page.blocks.length : cur.index, page.blocks.length));
        page.blocks.splice(insertIndex, 0, block);
        this.cursor = { scope: 'page', index: insertIndex + 1 };
      } else if (cur.scope === 'column') {
        const targetLoc = findBlockInPage(page, cur.columnsBlockId);
        if (!targetLoc || targetLoc.block.type !== 'columns') return;
        const col = targetLoc.block.content[cur.colIndex];
        if (!col) return;
        const insertIndex = Math.max(0, Math.min(cur.index < 0 ? col.length : cur.index, col.length));
        col.splice(insertIndex, 0, block);
        this.cursor = { scope: 'column', columnsBlockId: cur.columnsBlockId, colIndex: cur.colIndex, index: insertIndex + 1 };
      } else {
        const targetLoc = findBlockInPage(page, cur.divBlockId);
        if (!targetLoc || targetLoc.block.type !== 'div') return;
        const insertIndex = Math.max(0, Math.min(cur.index < 0 ? targetLoc.block.children.length : cur.index, targetLoc.block.children.length));
        targetLoc.block.children.splice(insertIndex, 0, block);
        this.cursor = { scope: 'div', divBlockId: cur.divBlockId, index: insertIndex + 1 };
      }
    });
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
  private normalizeCursor(page: NospressPageV2): void {
    const cur = this.cursor;
    if (cur.scope === 'page') {
      if (cur.index < 0 || cur.index > page.blocks.length) {
        this.cursor = { scope: 'page', index: page.blocks.length };
      }
      return;
    }
    if (cur.scope === 'column') {
      const loc = findBlockInPage(page, cur.columnsBlockId);
      if (!loc || loc.block.type !== 'columns' || cur.colIndex >= loc.block.count) {
        this.cursor = { scope: 'page', index: page.blocks.length };
        return;
      }
      const col = loc.block.content[cur.colIndex] ?? [];
      if (cur.index < 0 || cur.index > col.length) {
        this.cursor = { scope: 'column', columnsBlockId: cur.columnsBlockId, colIndex: cur.colIndex, index: col.length };
      }
      return;
    }
    // scope === 'div'
    const loc = findBlockInPage(page, cur.divBlockId);
    if (!loc || loc.block.type !== 'div') {
      this.cursor = { scope: 'page', index: page.blocks.length };
      return;
    }
    if (cur.index < 0 || cur.index > loc.block.children.length) {
      this.cursor = { scope: 'div', divBlockId: cur.divBlockId, index: loc.block.children.length };
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
      parts.push(this.renderEditableBlock(block));
    }
    if (pageCursorIndex >= blocks.length) parts.push(slot);
    return parts.join('');
  }

  /**
   * Single editable-render dispatch. Container blocks (columns, div) need
   * the cursor-aware variant so the cursor can descend into them; everything
   * else goes through the standard BlockRenderer. Used at every nesting
   * level (page-level + inside columns + inside divs) so deep layouts work.
   */
  private renderEditableBlock(block: Block): string {
    if (block.type === 'columns') return this.renderColumnsBlockEditable(block);
    if (block.type === 'div') return this.renderDivBlockEditable(block);
    return BlockRenderer.renderOne(block, { editable: true });
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

    const html = renderColumns(block, {
      editable: true,
      columnInner: (colIndex: number) => {
        const colBlocks = block.content[colIndex] ?? [];
        const cursorHere = cur.scope === 'column'
          && cur.columnsBlockId === block.id
          && cur.colIndex === colIndex;

        if (colBlocks.length === 0) {
          return cursorHere
            ? slot
            : `<div class="nospress-block-columns__placeholder" data-columns-block-id="${block.id}" data-col-index="${colIndex}" role="button" tabindex="0">Click to add blocks here</div>`;
        }

        const inner: string[] = [];
        for (let i = 0; i < colBlocks.length; i++) {
          if (cursorHere && cur.index === i) inner.push(slot);
          const cb = colBlocks[i]!;
          inner.push(this.renderEditableBlock(cb));
        }
        if (cursorHere && cur.index >= colBlocks.length) inner.push(slot);
        return inner.join('');
      }
    });
    // Editor-mode bare wrapper — no inline styles, custom class, or id
    // (those only apply on the published Public page).
    return `<div class="nospress-block-style" data-styled-block-id="${block.id}">${html}</div>`;
  }

  /**
   * Render a `div` block with editable children. Mirrors the columns
   * pattern: when the cursor is inside this div, the cursor-row slot lands
   * at the active index; otherwise an empty-children placeholder lets the
   * user click to drop the cursor in.
   */
  private renderDivBlockEditable(block: Extract<Block, { type: 'div' }>): string {
    const slot = `<div data-cursor-mount></div>`;
    const cur = this.cursor;
    const cursorHere = cur.scope === 'div' && cur.divBlockId === block.id;

    const html = renderDiv(block, {
      editable: true,
      childrenInner: () => {
        if (block.children.length === 0) {
          return cursorHere
            ? slot
            : `<div class="nospress-block-div__placeholder" data-div-block-id="${block.id}" role="button" tabindex="0">Click to add blocks here</div>`;
        }

        const inner: string[] = [];
        for (let i = 0; i < block.children.length; i++) {
          if (cursorHere && cur.index === i) inner.push(slot);
          const cb = block.children[i]!;
          inner.push(this.renderEditableBlock(cb));
        }
        if (cursorHere && cur.index >= block.children.length) inner.push(slot);
        return inner.join('');
      }
    });
    return `<div class="nospress-block-style" data-styled-block-id="${block.id}">${html}</div>`;
  }

  /**
   * Inline properties panel — rendered directly under the selected block,
   * pushing later blocks down. Empty placeholder for now; real controls
   * (margin, padding, color, alignment, …) follow per block-type later.
   * Works on Mobile too because it's just another row in the same column.
   */
  private renderInlineProperties(block: Block): string {
    return renderPropertyPanel({
      scope: `${block.type}:${block.id}`,
      style: block.style,
      attrs: block.attrs,
      header: 'Block properties',
    });
  }

  private renderInlinePageProperties(): string {
    return renderPropertyPanel({
      scope: 'page',
      style: this.currentPageStyle(),
      header: 'Page properties',
    });
  }

  /**
   * Custom-CSS editor panel — sits between the header and the page-edit
   * area. Same UI is opened from the header "CSS Editor" button and from
   * the "Custom CSS" card in the Block Library.
   *
   * Live behavior: typing in the textarea silently mutates the draft (no
   * re-render so focus stays put). The CSS is NOT applied to the DOM until
   * the user clicks Save — same trade-off the user picked, since constant
   * re-parses on every keystroke would flicker.
   */
  private renderCssEditorPanel(page: NospressPageV2): string {
    const value = page.customCss ?? '';
    return `
      <div class="nospress-css-editor">
        <div class="nospress-css-editor__head">
          <label class="nospress-css-editor__label">Custom CSS</label>
          <div class="nospress-css-editor__head-actions">
            <button type="button" class="btn btn--mini btn--passive" data-action="insert-palette-template" title="Insert a palette skeleton at the cursor — override the site-wide colors in one place">+ Palette</button>
            <button type="button" class="btn btn--mini btn--passive" data-action="close-css-editor" aria-label="Close">×</button>
          </div>
        </div>
        <textarea
          class="textarea textarea--code nospress-css-editor__textarea"
          data-css-editor
          spellcheck="false"
          placeholder="/* Selectors are scoped to .user-site\n   Use 'body' to target the page itself.\n   Click Save below to apply. */"
        >${escapeHtml(value)}</textarea>
        <div class="nospress-css-editor__hint">
          <p>Selectors apply to <code>.user-site</code> and its descendants. <code>body</code> targets the page wrapper itself.</p>
          <pre class="nospress-css-editor__tree">body
  .layout-wrapper
    [your blocks]   <span class="nospress-css-editor__tree-note">— target via the Identifiers panel (CSS Class / CSS ID)</span></pre>
          <p class="nospress-css-editor__palette-label"><strong>Palette</strong> — override site-wide by setting these inside <code>body { … }</code>:</p>
          <div class="nospress-css-editor__palette">
            <div><code>--color-1</code> <span>background</span></div>
            <div><code>--color-4</code> <span>interactive (links, buttons)</span></div>
            <div><code>--color-2</code> <span>surfaces, borders</span></div>
            <div><code>--color-5</code> <span>text</span></div>
            <div><code>--color-3</code> <span>accent</span></div>
            <div><code>--color-6</code> <span>status indicators</span></div>
          </div>
        </div>
      </div>
    `;
  }

  /** Skeleton inserted by the "+ Palette" button — current NoorNote defaults
   *  with comments next to each line. The user tweaks values from there. */
  private static readonly PALETTE_TEMPLATE = `body {
  --color-1: #0f0d23;  /* background */
  --color-2: #252343;  /* surfaces, borders */
  --color-3: #9b79b9;  /* accent */
  --color-4: #dc85ad;  /* interactive (links, buttons) */
  --color-5: #ede2da;  /* text */
  --color-6: #7dd87d;  /* status */
}
`;

  /**
   * Insert the palette skeleton at the textarea's cursor position. Empty
   * textarea → starts at column 0; otherwise injected at caret with a
   * leading newline if the previous char isn't already one. Dispatches a
   * synthetic `input` event so the silent draft save runs.
   */
  private insertPaletteTemplate(): void {
    const ta = this.container.querySelector('textarea[data-css-editor]') as HTMLTextAreaElement | null;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const value = ta.value;
    const prefix = (start > 0 && value[start - 1] !== '\n') ? '\n' : '';
    const insertion = prefix + NospressView.PALETTE_TEMPLATE;
    ta.value = value.slice(0, start) + insertion + value.slice(end);
    const caret = start + insertion.length;
    ta.selectionStart = ta.selectionEnd = caret;
    ta.focus();
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** Toggle the Custom-CSS panel. */
  private toggleCssEditor(): void {
    this.cssEditorOpen = !this.cssEditorOpen;
    this.rerenderEditable();
  }

  /** Read the active page style (in-memory draft → saved draft → published → migrated v1). */
  private currentPageStyle(): CommonStyle | undefined {
    const editSlug = this.currentEditSlug();
    return (this.editingPage
      ?? this.listService.getDraftV2(editSlug)
      ?? this.listService.getPublishedV2(editSlug)
      ?? this.listService.getPageV2(editSlug)
    ).style;
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
   *  blocks AND blocks nested inside a `columns` column or a `div`
   *  (regardless of where that container itself sits in the page tree). */
  private async setCursorAfterBlock(blockId: string): Promise<void> {
    const editSlug = this.currentEditSlug();
    const current = this.listService.getDraftV2(editSlug)
      ?? this.listService.getPublishedV2(editSlug)
      ?? this.listService.getPageV2(editSlug);
    const loc = findBlockInPage(current, blockId);
    if (!loc) return;

    if (!loc.container) {
      this.cursor = { scope: 'page', index: loc.index + 1 };
    } else if (loc.container.type === 'column') {
      this.cursor = { scope: 'column', columnsBlockId: loc.container.block.id, colIndex: loc.container.colIndex, index: loc.index + 1 };
    } else {
      this.cursor = { scope: 'div', divBlockId: loc.container.block.id, index: loc.index + 1 };
    }

    await this.rerenderEditable();
    this.flashCursorRow();
  }

  /** Move cursor INTO an empty column. Triggered by clicking the column's
   *  "Click to add blocks here" placeholder. */
  private async setCursorInColumn(columnsBlockId: string, colIndex: number): Promise<void> {
    this.cursor = { scope: 'column', columnsBlockId, colIndex, index: 0 };
    await this.rerenderEditable();
    this.flashCursorRow();
  }

  /** Move cursor INTO an empty div. Triggered by clicking the div's
   *  "Click to add blocks here" placeholder. */
  private async setCursorInDiv(divBlockId: string): Promise<void> {
    this.cursor = { scope: 'div', divBlockId, index: 0 };
    await this.rerenderEditable();
    this.flashCursorRow();
  }

  /** Scroll the cursor-row into view + brief flash + focus its input. */
  private flashCursorRow(): void {
    const el = this.cursorRow?.getElement();
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('nospress-cursor-row--flash');
    setTimeout(() => el.classList.remove('nospress-cursor-row--flash'), 600);
    this.cursorRow?.focus();
  }

  /**
   * Select / deselect a block. Pure UI state — no data mutation.
   * In-place re-render so the inline properties panel (rendered directly
   * under the selected block by `renderBlocksWithCursor`) shows up or
   * hides. Uses rerenderEditable to skip the loading spinner and relay
   * fetch — selection is local UI state, no remote data is needed.
   */
  private selectBlock(blockId: string | null): void {
    if (this.selectedBlockId === blockId) return;
    this.selectedBlockId = blockId;
    this.rerenderEditable();
    this.updatePropertiesTab();
  }

  /** Toggle the `--selected` class on the matching wrapper. Called after
   *  every editable re-render so the focus survives state changes. Also
   *  handles the virtual Page frame when PAGE_SELECTION_ID is selected. */
  private applySelectedBlockClass(): void {
    this.container.querySelectorAll('.nospress-block-edit--selected, .nospress-page-edit--selected').forEach(el => {
      el.classList.remove('nospress-block-edit--selected', 'nospress-page-edit--selected');
    });
    if (!this.selectedBlockId) return;
    if (this.selectedBlockId === PAGE_SELECTION_ID) {
      this.container.querySelector('.nospress-page-edit')?.classList.add('nospress-page-edit--selected');
      return;
    }
    const wrapper = this.container.querySelector(
      `.nospress-block-edit[data-block-id="${this.selectedBlockId}"]`
    );
    wrapper?.classList.add('nospress-block-edit--selected');
  }

  private saveDraft(): void {
    if (!this.editingPage) {
      ToastService.show('Nothing to save', 'error');
      return;
    }
    this.listService.saveDraftV2(this.editingPage, { silent: true, slug: this.currentEditSlug() });
    this.isDirty = false;
    this.refreshActionBar();
    this.updatePagesTab();
    ToastService.show('Saved', 'success');
  }

  private async discardDraft(): Promise<void> {
    const confirmed = await ModalService.getInstance().confirm({
      title: 'Discard draft',
      message: 'This removes all unpublished changes from this device. The page on relays is not affected. Cannot be undone.',
      confirmDestructive: true,
    });
    if (!confirmed) return;
    this.listService.clearDraftV2(this.currentEditSlug());
    this.editingPage = null;
    this.isDirty = false;
    ToastService.show('Draft discarded', 'success');
    this.rerenderEditable();
    this.updatePagesTab();
  }

  private async publishDraft(): Promise<void> {
    const editSlug = this.currentEditSlug();
    if (this.isDirty && this.editingPage) {
      // Persist pending edits before publishing
      this.listService.saveDraftV2(this.editingPage, { silent: true, slug: editSlug });
      this.isDirty = false;
    }
    const draft = this.listService.getDraftV2(editSlug);
    if (!draft) {
      ToastService.show('No draft to publish', 'error');
      return;
    }

    try {
      await this.orchestrator.publishV2ToRelays(draft, editSlug);
      this.listService.savePublishedV2(draft, editSlug);

      this.listService.clearDraftV2(editSlug);
      this.editingPage = null;
      this.isDirty = false;
      this.updatePagesTab();
      ToastService.show('Page published', 'success');
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
      } else if (kind === 'div-tag') {
        const current = slot.dataset.currentValue || 'div';
        const dropdown = new CustomDropdown({
          options: DIV_TAGS.map(t => ({ value: t, label: t })),
          selectedValue: current,
          onChange: (value) => {
            this.mutateDraft((page) => {
              const block = findBlockInPage(page, blockId)?.block;
              if (block && block.type === 'div' && (DIV_TAGS as readonly string[]).includes(value)) {
                block.tag = value as DivTag;
              }
            }, { silent: false });
          }
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


  /**
   * Update a single style field from an inline input. The editor is a
   * schematic composer — we silently persist the value to the draft but
   * do NOT apply it to the editor DOM. The styled result shows up only on
   * the published Public page.
   */
  private handleStyleInput(scope: string, field: string, rawValue: string): void {
    if (scope === 'page') {
      this.mutateDraft((page) => {
        if (!page.style) page.style = {};
        writeStyleField(page.style, field, rawValue);
      }, { silent: true });
      return;
    }
    // Block scope: '<blockType>:<uuid>' — only the id portion is needed.
    const colon = scope.indexOf(':');
    if (colon < 0) return;
    const blockId = scope.slice(colon + 1);
    this.mutateDraft((page) => {
      const loc = findBlockInPage(page, blockId);
      if (!loc) return;
      if (!loc.block.style) loc.block.style = {};
      writeStyleField(loc.block.style, field, rawValue);
    }, { silent: true });
  }

  /**
   * Per-block class/id "Identifiers" handler. Same schematic-composer rule
   * as handleStyleInput — persist silently, don't touch the editor DOM.
   * The class/id show up on the published wrapper only.
   */
  private handleAttrInput(scope: string, field: string, rawValue: string): void {
    if (field !== 'class' && field !== 'id') return;
    const colon = scope.indexOf(':');
    if (colon < 0) return;
    const blockId = scope.slice(colon + 1);
    const sanitized = sanitizeCssIdent(rawValue, field === 'class' ? 'multi' : 'single');
    this.mutateDraft((page) => {
      const loc = findBlockInPage(page, blockId);
      if (!loc) return;
      if (!loc.block.attrs) loc.block.attrs = {};
      if (sanitized) loc.block.attrs[field] = sanitized;
      else delete loc.block.attrs[field];
    }, { silent: true });
  }

  /**
   * Custom-CSS textarea input. Silent draft mutation only — no DOM apply
   * here; the user explicitly clicks Save to push the new CSS to the page.
   */
  private handleCssEditorInput(value: string): void {
    this.mutateDraft((page) => {
      page.customCss = value;
    }, { silent: true });
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
    const handleFieldEvent = (e: Event) => {
      const target = e.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      const blockId = target.dataset?.blockId;
      const field = target.dataset?.field;
      if (blockId && field) this.handleBlockFieldInput(blockId, field, target);

      const styleScope = target.dataset?.styleScope;
      const styleField = target.dataset?.styleField;
      if (styleScope && styleField) this.handleStyleInput(styleScope, styleField, target.value);

      const attrScope = target.dataset?.attrScope;
      const attrField = target.dataset?.attrField;
      if (attrScope && attrField) this.handleAttrInput(attrScope, attrField, target.value);

      if (target.dataset?.cssEditor !== undefined) this.handleCssEditorInput(target.value);
    };
    this.container.addEventListener('input', handleFieldEvent);
    this.container.addEventListener('change', handleFieldEvent);

    this.container.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
      if (!btn || (btn as HTMLButtonElement).disabled) return;
      const action = btn.dataset.action!;

      // Action-bar buttons (no blockId required)
      switch (action) {
        case 'save':                   this.saveDraft(); return;
        case 'discard':                this.discardDraft(); return;
        case 'publish':                this.publishDraft(); return;
        case 'delete-list':            this.confirmAndUnpublish(); return;
        case 'dm-page-owner':          Router.getInstance().navigate(`/messages/${this.npub}`); return;
        case 'close-css-editor':       this.toggleCssEditor(); return;
        case 'insert-palette-template': this.insertPaletteTemplate(); return;
      }

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
        case 'upload-video':           this.triggerVideoUpload(blockId); break;
        case 'upload-audio':           this.triggerAudioUpload(blockId); break;
      }
    });

    // Block selection — click on a block's wrapper (but NOT on its
    // interactive descendants, which have their own handlers) selects it.
    // Click outside any block clears the selection.
    this.container.addEventListener('click', (e) => {
      if (!this.editMode) return;
      const target = e.target as HTMLElement;

      // Click on an empty-column placeholder → put cursor in that column
      const ph = target.closest('.nospress-block-columns__placeholder') as HTMLElement | null;
      if (ph) {
        const cbId = ph.dataset.columnsBlockId;
        const colIdx = ph.dataset.colIndex !== undefined ? parseInt(ph.dataset.colIndex, 10) : -1;
        if (cbId && colIdx >= 0) {
          this.setCursorInColumn(cbId, colIdx);
          return;
        }
      }

      // Click on an empty-div placeholder → put cursor in that div
      const divPh = target.closest('.nospress-block-div__placeholder') as HTMLElement | null;
      if (divPh) {
        const dbId = divPh.dataset.divBlockId;
        if (dbId) {
          this.setCursorInDiv(dbId);
          return;
        }
      }

      // Skip clicks on interactive controls — those have their own handlers
      if (target.closest('button, input, textarea, select, a, [data-action]')) return;
      // Click inside the inline properties panel of the selected block:
      // keep selection (don't toggle off, the user is interacting with the panel)
      if (target.closest('.nospress-block-properties')) return;

      // Inner block wrapper takes precedence over the outer page frame
      const blockWrapper = target.closest('.nospress-block-edit') as HTMLElement | null;
      if (blockWrapper) {
        const blockId = blockWrapper.dataset.blockId ?? null;
        this.selectBlock(blockId === this.selectedBlockId ? null : blockId);
        return;
      }

      // Click landed inside the page frame but not on any inner block — select page
      const pageWrapper = target.closest('.nospress-page-edit') as HTMLElement | null;
      if (pageWrapper) {
        this.selectBlock(this.selectedBlockId === PAGE_SELECTION_ID ? null : PAGE_SELECTION_ID);
        return;
      }

      // Click outside everything → deselect
      this.selectBlock(null);
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
      if (target?.dataset?.videoFile !== undefined) {
        const blockId = target.dataset.blockId;
        const file = target.files?.[0];
        if (!blockId || !file) return;
        target.value = '';
        await this.handleVideoUpload(blockId, file);
        return;
      }
      if (target?.dataset?.audioFile !== undefined) {
        const blockId = target.dataset.blockId;
        const file = target.files?.[0];
        if (!blockId || !file) return;
        target.value = '';
        await this.handleAudioUpload(blockId, file);
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
   * Mutate the in-memory editing page. Persisted to draft storage only on
   * explicit Save click. Structural changes (delete/move/add) re-render;
   * field-level edits pass silent=true to keep input focus.
   */
  private mutateDraft(updater: (page: NospressPageV2) => void, opts: { silent?: boolean } = {}): void {
    if (!this.editingPage) {
      const editSlug = this.currentEditSlug();
      this.editingPage = JSON.parse(JSON.stringify(
        this.listService.getDraftV2(editSlug)
          ?? this.listService.getPublishedV2(editSlug)
          ?? this.listService.getPageV2(editSlug)
      ));
    }
    updater(this.editingPage!);
    this.isDirty = true;
    this.refreshActionBar();
    if (opts.silent !== true) {
      this.rerenderEditable();
    }
  }

  /**
   * Fast in-place re-render for edit-mode mutations. Skips the loading
   * spinner + relay fetch that loadAndRender does — the editingPage is the
   * truth source in edit mode, so we render straight from it.
   */
  private async rerenderEditable(): Promise<void> {
    this.destroyInlineMounts();
    await this.renderList();
    await this.mountInlineBookmarkFolders();
  }

  private handleBlockFieldInput(blockId: string, field: string, el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): void {
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
      } else if (block.type === 'dm-button') {
        if (field === 'dm-label') block.label = el.value;
      } else if (block.type === 'quote') {
        if (field === 'quote-text')   block.text = el.value;
        if (field === 'quote-author') block.author = el.value;
        if (field === 'quote-source') block.source = el.value;
      } else if (block.type === 'button-cta') {
        if (field === 'cta-label')   block.label = el.value;
        if (field === 'cta-url')     block.url = el.value;
        if (field === 'cta-variant') block.variant = el.value === 'secondary' ? 'secondary' : 'primary';
      } else if (block.type === 'video') {
        if (field === 'video-url')     block.url = el.value;
        if (field === 'video-caption') block.caption = el.value;
        if (field === 'video-poster')  block.poster = el.value;
      } else if (block.type === 'audio') {
        if (field === 'audio-url')     block.url = el.value;
        if (field === 'audio-caption') block.caption = el.value;
      } else if (block.type === 'articles-list') {
        if (field === 'articles-pubkey') {
          const v = el.value.trim();
          if (v) block.pubkey = v; else delete block.pubkey;
        }
      } else if (block.type === 'nav-menu') {
        if (field === 'menu-id') block.menuId = el.value;
      } else if (block.type === 'weblog') {
        if (field === 'weblog-pubkey') {
          const v = el.value.trim();
          if (v) block.pubkey = v; else delete block.pubkey;
        }
        if (field === 'weblog-hashtags') {
          block.hashtags = el.value.split(',').map(s => s.trim().replace(/^#/, '').toLowerCase()).filter(Boolean);
        }
        if (field === 'weblog-posts-per-page') {
          const n = parseInt(el.value, 10);
          if (Number.isFinite(n) && n > 0) block.postsPerPage = n; else delete block.postsPerPage;
        }
        if (field === 'weblog-exclude-replies' && el instanceof HTMLInputElement) {
          block.excludeReplies = el.checked;
        }
        if (field === 'weblog-exclude-reposts' && el instanceof HTMLInputElement) {
          block.excludeReposts = el.checked;
        }
      }
    }, { silent: true });

    // nav-menu's menu-id is read at render time to set `data-menu-id` on
    // the mount slot. A silent mutate updates the in-memory block but
    // leaves the slot pointing at the old menu — re-render so the preview
    // reflects the new pick.
    if (field === 'menu-id') {
      this.rerenderEditable();
    }
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

  private triggerVideoUpload(blockId: string): void {
    const fileInput = this.container.querySelector(`[data-block-id="${blockId}"][data-video-file]`) as HTMLInputElement | null;
    fileInput?.click();
  }

  private triggerAudioUpload(blockId: string): void {
    const fileInput = this.container.querySelector(`[data-block-id="${blockId}"][data-audio-file]`) as HTMLInputElement | null;
    fileInput?.click();
  }

  private async handleVideoUpload(blockId: string, file: File): Promise<void> {
    if (!file.type.startsWith('video/')) {
      ToastService.show('Please select a video file', 'error');
      return;
    }
    const uploadBtn = this.container.querySelector(`[data-block-id="${blockId}"][data-action="upload-video"]`) as HTMLButtonElement | null;
    if (!uploadBtn) return;

    const originalHTML = uploadBtn.innerHTML;
    uploadBtn.disabled = true;
    uploadBtn.innerHTML = `
      <svg width="20" height="20" class="upload-progress" viewBox="0 0 24 24">
        <circle class="upload-progress-bg" cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" opacity="0.2"/>
        <circle class="upload-progress-bar" cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="62.83" stroke-dashoffset="62.83"/>
      </svg>
    `;

    const updateProgress = (progress: number) => {
      const bar = uploadBtn.querySelector('.upload-progress-bar') as SVGCircleElement | null;
      if (!bar) return;
      const circumference = 62.83;
      const offset = circumference - (progress / 100) * circumference;
      bar.style.strokeDashoffset = String(offset);
    };

    try {
      const result = await MediaUploadService.getInstance().uploadFile(file, updateProgress);
      if (result.success && result.url) {
        const url = result.url;
        this.mutateDraft((page) => {
          const block = findBlockInPage(page, blockId)?.block;
          if (block?.type === 'video') block.url = url;
        });
      }
    } catch (error) {
      console.error('Video upload failed:', error);
      ToastService.show('Video upload failed', 'error');
    } finally {
      if (uploadBtn.isConnected) {
        uploadBtn.disabled = false;
        uploadBtn.innerHTML = originalHTML;
      }
    }
  }

  private async handleAudioUpload(blockId: string, file: File): Promise<void> {
    if (!file.type.startsWith('audio/')) {
      ToastService.show('Please select an audio file', 'error');
      return;
    }
    const uploadBtn = this.container.querySelector(`[data-block-id="${blockId}"][data-action="upload-audio"]`) as HTMLButtonElement | null;
    if (!uploadBtn) return;

    const originalHTML = uploadBtn.innerHTML;
    uploadBtn.disabled = true;
    uploadBtn.innerHTML = `
      <svg width="20" height="20" class="upload-progress" viewBox="0 0 24 24">
        <circle class="upload-progress-bg" cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" opacity="0.2"/>
        <circle class="upload-progress-bar" cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="62.83" stroke-dashoffset="62.83"/>
      </svg>
    `;

    const updateProgress = (progress: number) => {
      const bar = uploadBtn.querySelector('.upload-progress-bar') as SVGCircleElement | null;
      if (!bar) return;
      const circumference = 62.83;
      const offset = circumference - (progress / 100) * circumference;
      bar.style.strokeDashoffset = String(offset);
    };

    try {
      const result = await MediaUploadService.getInstance().uploadFile(file, updateProgress);
      if (result.success && result.url) {
        const url = result.url;
        this.mutateDraft((page) => {
          const block = findBlockInPage(page, blockId)?.block;
          if (block?.type === 'audio') block.url = url;
        });
      }
    } catch (error) {
      console.error('Audio upload failed:', error);
      ToastService.show('Audio upload failed', 'error');
    } finally {
      if (uploadBtn.isConnected) {
        uploadBtn.disabled = false;
        uploadBtn.innerHTML = originalHTML;
      }
    }
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
