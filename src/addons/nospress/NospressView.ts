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
import { AuthService } from '../../services/AuthService';
import { NospressOrchestrator } from '../../services/orchestration/NospressOrchestrator';
import { NospressService } from '../../services/NospressService';
import { BlockRenderer } from './blocks/BlockRenderer';
import { renderColumns } from './blocks/renderers/ColumnsRenderer';
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
import { createBlock, findBlockInPage, type Block, type BlockType, type NospressPageV2 } from './blocks/types';
import {
  buildInlineStyle,
  renderPropertyPanel,
  schemaFor,
  styleWrap,
  writeStyleField,
  type CommonStyle,
} from './blocks/styles';
import { escapeHtmlAttr } from '../../helpers/escapeHtml';
import { switchTabWithContent, createClosableTab } from '../../helpers/TabsHelper';
import { BookmarkFolderPicker } from '../../components/ui/BookmarkFolderPicker';
import { CustomDropdown } from '../../components/ui/CustomDropdown';
import { MediaUploadService } from '../../services/MediaUploadService';
import { mountNospressEmbeds } from './embedMount';
import DOMPurify from 'dompurify';

const BLOCK_LIBRARY_TAB_ID = 'nospress-block-library';

/** Reserved value for `selectedBlockId` that selects the virtual Page wrapper
 *  (the always-present outer frame in the editor). Not a real Block.id —
 *  prefixed with `__` so it can never collide with a UUID. */
const PAGE_SELECTION_ID = '__page__';

/** Active editor cursor — either at page level or inside a specific column
 *  of a `columns` block. `index` is the position WITHIN the parent array. */
type Cursor =
  | { scope: 'page'; index: number }
  | { scope: 'column'; columnsBlockId: string; colIndex: number; index: number };

export class NospressView extends View {
  private container: HTMLElement;
  private npub: string;
  private pubkey: string;
  private isOwnProfile: boolean;
  private orchestrator: NospressOrchestrator;
  private listService: NospressService;
  /** One ProfileListsComponent per inline bookmark-folder block in the page,
   *  mounted into the slot the BookmarkFolderRenderer's readonly path emits. */
  private inlineMountsComponents: ProfileListsComponent[] = [];
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
  /** Currently focused/selected block in the editor. Null = none. UI-only.
   *  May also be PAGE_SELECTION_ID — selects the virtual Page wrapper, whose
   *  properties panel surfaces site-level options (color, background, etc.). */
  private selectedBlockId: string | null = null;
  private eventBusSubscriptions: string[] = [];
  /** Live in-memory edit state. All mutations go here; persisted to draft
   *  storage only when the user clicks Save. Null until first edit. */
  private editingPage: NospressPageV2 | null = null;
  private isDirty: boolean = false;
  /** v2 page fetched from a foreign user's relays (NIP-65 outbox).
   *  Null for own profile (which renders from local draft/published). */
  private remotePage: NospressPageV2 | null = null;
  /** Fullscreen overlay handle. Active means this.container is currently
   *  re-parented into the overlay's editor slot. */
  private fullscreenOverlay: FullscreenOverlay | null = null;
  private fullscreenOriginParent: HTMLElement | null = null;
  private fullscreenOriginAnchor: Node | null = null;
  /** True when the view was mounted via the /edit/fullscreen route. The
   *  initial render triggers enterFullscreenEditor() automatically once the
   *  page is ready. Cleared after the first successful trigger. */
  private bootFullscreen: boolean = false;

  constructor(npub: string, opts: { editMode?: boolean; fullscreen?: boolean } = {}) {
    super();
    this.npub = npub;
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--nospress';
    this.orchestrator = NospressOrchestrator.getInstance();
    this.listService = NospressService.getInstance();

    try {
      const decoded = decodeNip19(npub);
      this.pubkey = decoded.type === 'npub'
        ? decoded.data as string
        : (decoded.data as { pubkey: string }).pubkey;
    } catch {
      this.pubkey = '';
    }

    this.isOwnProfile = AuthService.getInstance().isCurrentUser(this.pubkey);
    if (opts.editMode && this.isOwnProfile) this.editMode = true;
    if (opts.fullscreen && this.isOwnProfile) this.bootFullscreen = true;

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
    this.destroyInlineMounts();
    this.destroyFolderPickers();
    this.destroyBlockDropdowns();
    this.destroyCursorRow();
    if (this.fullscreenOverlay) {
      this.fullscreenOverlay.unmount();
      this.fullscreenOverlay = null;
    }
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
      eventBus.on('nospressList:changed', () => this.rerenderEditable())
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
      if (this.isOwnProfile) {
        // Own profile: always pull the latest published state from relays so
        // edits made on a different instance show up immediately on this one.
        // Updates the publishedV2 mirror; renderList still prefers draftV2 /
        // editingPage when present so unsaved local work isn't clobbered.
        const remote = await this.orchestrator.fetchFromRelays(this.pubkey, true);
        if (remote && remote.blocks.length > 0) {
          this.listService.savePublishedV2(remote);
        }
      } else {
        this.remotePage = await this.orchestrator.fetchFromRelays(this.pubkey, true);
      }

      const hasContent = this.isOwnProfile
        ? this.listService.hasV2Content()
        : !!(this.remotePage && this.remotePage.blocks.length > 0);

      // Edit-mode renders the editable shell even when content is empty
      // (so the cursor row is visible on a fresh page).
      if (hasContent || (this.editMode && this.isOwnProfile)) {
        await this.renderList();
      } else {
        this.renderShellWithoutList();
      }

      // Mount inline bookmark-folder content into the slots emitted by
      // BookmarkFolderRenderer's readonly path.
      await this.mountInlineBookmarkFolders();

      // Empty state: only when there is no content AND no inline mounts. In
      // edit mode the cursor row is already the empty-state affordance.
      const hasMounts = this.container.querySelectorAll('.profile-lists-mount').length > 0;
      if (!hasContent && !hasMounts && !this.editMode) {
        this.renderEmpty();
      }

      // When the route opens us directly in edit mode, also open the full
      // editor surface — fullscreen overlay if /edit/fullscreen, otherwise
      // the SCC Block Library tab for /edit.
      if (this.editMode && this.isOwnProfile) {
        if (this.bootFullscreen) {
          this.bootFullscreen = false;
          this.enterFullscreenEditor();
        } else if (!this.blockLibrary) {
          this.openBlockLibrary();
        }
      }
    } catch (error) {
      console.error('Failed to load NosPress:', error);
      this.container.innerHTML = '<p class="nospress-error">Failed to load page.</p>';
    }
  }

  private renderEmpty(): void {
    this.container.innerHTML = `
      <div class="nospress-empty">
        <p>This user hasn't set up a page yet.</p>
      </div>
    `;
  }

  /**
   * Render header + empty list area when no custom list exists yet
   * (mounts can still be appended below by renderMounts()).
   */
  private async renderShellWithoutList(): Promise<void> {
    const username = await this.loadUsername();
    this.container.innerHTML = `
      <div class="nospress-view">
        <div class="nospress-header l-spread">
          <div>
            <button class="btn btn--medium btn--passive" data-action="back">&larr; Back to ${DOMPurify.sanitize(username)}'s profile</button>
          </div>
          <div>
            ${this.isOwnProfile ? `
              <button class="btn btn--medium btn--passive" data-action="open-block-editor">
                <svg width="14" height="14"><use href="#icon-edit"/></svg>
                Block Editor
              </button>
            ` : ''}
          </div>
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

  private async renderList(): Promise<void> {
    const username = await this.loadUsername();

    // Render priority for own profile:
    //   - Edit mode: in-memory editingPage (live unsaved edits) ?? saved draft ?? published ?? migrated v1
    //   - Preview:   saved draft ?? published ?? migrated v1 (NEVER in-memory edits)
    // Foreign profile: the v2 page fetched from the author's outbox relays.
    let page: NospressPageV2;
    if (this.isOwnProfile) {
      const stored = this.listService.getDraftV2()
        ?? this.listService.getPublishedV2()
        ?? this.listService.getPageV2();
      page = (this.editMode && this.editingPage) ? this.editingPage : stored;
    } else {
      page = this.remotePage ?? { version: 2, blocks: [] };
    }

    const editable = this.editMode && this.isOwnProfile;

    if (editable) {
      this.normalizeCursor(page);
    }

    // Page-meta (title/subtitle/description) are no longer rendered as a fixed
    // top section — the user composes them via Heading + Text blocks like any
    // other page content. The fields remain in NospressPageV2 for backwards
    // compatibility when reading old v2 events; they are no-ops in the UI.
    const blocksHtml = editable
      ? this.renderBlocksWithCursor(page.blocks)
      : BlockRenderer.renderAll(page.blocks, { editable: false });

    // Tear down old picker instances before innerHTML replaces their DOM
    this.destroyFolderPickers();
    this.destroyBlockDropdowns();

    const leftButtonHtml = editable
      ? `<button class="btn btn--medium btn--passive" data-action="preview-page" title="Close the editor and see the page as visitors see it">Preview Page</button>`
      : `<button class="btn btn--medium btn--passive" data-action="back">&larr; Back to ${DOMPurify.sanitize(username)}'s profile</button>`;

    const fullscreenButtonHtml = editable
      ? `<button class="btn btn--medium btn--passive" data-action="open-fullscreen" title="Open the editor in fullscreen with a side-by-side block library">Fullscreen</button>`
      : '';

    const rightButtonHtml = this.isOwnProfile
      ? `<button class="btn btn--medium btn--passive" data-action="open-block-editor" title="Open Block Library in the right sidebar"><svg width="14" height="14"><use href="#icon-edit"/></svg> Block Editor</button>`
      : '';

    const pageSelected = editable && this.selectedBlockId === PAGE_SELECTION_ID;
    const inlineStyle = buildInlineStyle(schemaFor('page'), page.style);
    const styleAttr = inlineStyle ? ` style="${escapeHtmlAttr(inlineStyle)}"` : '';
    const pageContentHtml = `<div class="nospress-page-content"${styleAttr}>${blocksHtml}</div>`;

    const composedBlocksHtml = editable
      ? `
        <div class="nospress-page-edit${pageSelected ? ' nospress-page-edit--selected' : ''}" data-block-id="${PAGE_SELECTION_ID}">
          <div class="nospress-page-edit__title-bar">PAGE</div>
          ${pageContentHtml}
        </div>
        ${pageSelected ? this.renderInlinePageProperties() : ''}
      `
      : pageContentHtml;

    this.container.innerHTML = `
      <div class="nospress-view">
        <div class="nospress-header l-spread">
          <div>${leftButtonHtml}</div>
          <div class="nospress-header__actions">${fullscreenButtonHtml}${rightButtonHtml}</div>
        </div>
        ${composedBlocksHtml}
        ${this.renderActionBar(editable)}
      </div>
    `;

    if (editable) {
      this.mountFolderPickers();
      this.mountBlockDropdowns();
      this.mountCursorRow();
      this.applySelectedBlockClass();
    }
    if (!editable) mountNospressEmbeds(this.container);

    this.bindHeaderEvents();
  }

  private renderActionBar(editable: boolean): string {
    if (!this.isOwnProfile) return '';
    const isDirty = this.isDirty;
    const hasDraft = this.listService.hasDraftV2();
    const hasPublished = this.listService.getPublishedV2() !== null;
    const localButtons = editable
      ? `
        <button type="button" class="btn btn--mini" data-action="save" ${isDirty ? '' : 'disabled'}>Save</button>
        <button type="button" class="btn btn--passive btn--mini" data-action="discard" ${hasDraft ? '' : 'disabled'}>Discard</button>
      `
      : '';
    return `
      <div class="nospress-action-bar l-row--split">
        <div>
          <button type="button" class="btn btn--mini" data-action="publish" ${(isDirty || hasDraft) ? '' : 'disabled'}>Publish</button>
          <button type="button" class="btn btn--passive btn--mini btn--danger" data-action="delete-list" ${hasPublished ? '' : 'disabled'}>Unpublish</button>
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
    tmp.innerHTML = this.renderActionBar(this.editMode && this.isOwnProfile);
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

  private bindHeaderEvents(): void {
    this.container.querySelector('[data-action="open-block-editor"]')?.addEventListener('click', () => {
      this.openBlockLibrary();
    });

    this.container.querySelector('[data-action="open-fullscreen"]')?.addEventListener('click', () => {
      this.enterFullscreenEditor();
    });

    this.container.querySelector('[data-action="preview-page"]')?.addEventListener('click', () => {
      this.closeBlockLibrary();
    });

    this.container.querySelector('[data-action="back"]')?.addEventListener('click', (e) => {
      e.preventDefault();
      Router.getInstance().navigate(`/profile/${this.npub}`);
    });
  }

  private async confirmAndUnpublish(): Promise<void> {
    const confirmed = await ModalService.getInstance().confirm({
      title: 'Unpublish page',
      message: 'This removes the published page from your relays. Your local draft is kept so you can re-publish later.',
      confirmDestructive: true,
    });
    if (!confirmed) return;

    try {
      await this.orchestrator.deleteFromRelays();
      this.listService.clearPublishedV2();
      this.listService.deleteList();
      this.refreshActionBar();
      ToastService.show('Unpublished', 'success');
    } catch (error) {
      console.error('Failed to unpublish:', error);
      ToastService.show('Unpublish failed', 'error');
    }
  }

  /**
   * Inject the Block Library tab into the SCC and switch to it.
   * Tab is removed when NospressView destroys (= user navigates away).
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
        onSelectPage: () => this.selectBlock(this.selectedBlockId === PAGE_SELECTION_ID ? null : PAGE_SELECTION_ID),
      });
      tabContent = document.createElement('div');
      tabContent.className = 'tab-content';
      tabContent.dataset.tabContent = BLOCK_LIBRARY_TAB_ID;
      tabContent.appendChild(this.blockLibrary.getElement());
      contentBody.appendChild(tabContent);
    }

    switchTabWithContent(secondaryContent, BLOCK_LIBRARY_TAB_ID);
    window.history.pushState({}, '', `/profile/${this.npub}/nospress/edit`);
    if (!this.editMode) {
      this.editMode = true;
      this.rerenderEditable();
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

    window.history.pushState({}, '', `/profile/${this.npub}/nospress`);
    if (this.editMode) {
      this.editMode = false;
      this.rerenderEditable();
    }
  }

  /**
   * Open the editor in a fullscreen overlay with a side-by-side block library
   * (70/30 split on desktop, library hidden on mobile — slash menu remains).
   * Re-parents `this.container` into the overlay's editor slot so the existing
   * render pipeline keeps writing to the same element. Cursor, selection, and
   * draft state are preserved across the transition because the single source
   * of truth is `NospressService.draftV2`.
   */
  private enterFullscreenEditor(): void {
    if (this.fullscreenOverlay?.isMounted()) return;

    // Tear down the SCC tab if it was open — but keep editMode + cursor state.
    document.querySelector(`#sidebar-tabs > [data-tab="${BLOCK_LIBRARY_TAB_ID}"]`)?.remove();
    document.querySelector(`.secondary-content-body > [data-tab-content="${BLOCK_LIBRARY_TAB_ID}"]`)?.remove();
    this.blockLibrary?.destroy();
    this.blockLibrary = null;
    const secondaryContent = document.querySelector('.secondary-content') as HTMLElement | null;
    if (secondaryContent && !secondaryContent.querySelector('.tab--active')) {
      switchTabWithContent(secondaryContent, 'system-log');
    }

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

    // Remember where to put this.container back when we exit.
    this.fullscreenOriginParent = this.container.parentElement as HTMLElement | null;
    this.fullscreenOriginAnchor = this.container.nextSibling;
    editorSlot.appendChild(this.container);
    this.container.classList.add('nospress-view--fullscreen');

    this.blockLibrary = new BlockLibraryView({
      onApply: (type) => this.applyBlock(type),
      onSelectPage: () => this.selectBlock(this.selectedBlockId === PAGE_SELECTION_ID ? null : PAGE_SELECTION_ID),
    });
    librarySlot.appendChild(this.blockLibrary.getElement());

    if (!this.editMode) this.editMode = true;
    this.rerenderEditable();

    const fullscreenPath = `/profile/${this.npub}/nospress/edit/fullscreen`;
    if (window.location.pathname !== fullscreenPath) {
      window.history.pushState({}, '', fullscreenPath);
    }

    // "See Website" → opens the public NosPress page in a new tab.
    // Initial href uses the canonical npub form (works always); upgraded
    // to the prettier nip05 form in-place if the profile has one. The
    // public URL itself is rendered by Phase 5's boot path on noornote.app.
    const seeWebsiteAnchor = document.createElement('a');
    seeWebsiteAnchor.className = 'btn btn--passive btn--medium';
    seeWebsiteAnchor.target = '_blank';
    seeWebsiteAnchor.rel = 'noopener noreferrer';
    seeWebsiteAnchor.textContent = 'See Website';
    seeWebsiteAnchor.href = `https://noornote.app/${this.npub}/`;
    UserProfileService.getInstance().getUserProfile(this.pubkey).then(profile => {
      const nip05 = profile?.nip05?.trim();
      if (nip05) seeWebsiteAnchor.href = `https://noornote.app/${nip05}/`;
    }).catch(() => { /* keep npub fallback */ });

    this.fullscreenOverlay = new FullscreenOverlay({
      title: 'Edit Page',
      exitLabel: 'Exit Fullscreen',
      body: split,
      maxWidth: '100%',
      extraActions: [seeWebsiteAnchor],
      onExit: () => this.cleanupFullscreenEditor(),
    });
    this.fullscreenOverlay.mount();
  }

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

    if (this.editMode) {
      this.editMode = false;
      this.rerenderEditable();
    }

    const previewPath = `/profile/${this.npub}/nospress`;
    if (window.location.pathname !== previewPath) {
      window.history.pushState({}, '', previewPath);
    }

    this.fullscreenOverlay = null;
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

    // Validate nested-columns up-front so we don't toggle dirty for a no-op
    if (cur.scope === 'column' && block.type === 'columns') {
      ToastService.show('Columns inside columns are not supported', 'error');
      return;
    }

    this.mutateDraft((page) => {
      if (cur.scope === 'page') {
        const insertIndex = Math.max(0, Math.min(cur.index < 0 ? page.blocks.length : cur.index, page.blocks.length));
        page.blocks.splice(insertIndex, 0, block);
        this.cursor = { scope: 'page', index: insertIndex + 1 };
      } else {
        const target = page.blocks.find(b => b.id === cur.columnsBlockId);
        if (!target || target.type !== 'columns') return;
        const col = target.content[cur.colIndex];
        if (!col) return;
        const insertIndex = Math.max(0, Math.min(cur.index < 0 ? col.length : cur.index, col.length));
        col.splice(insertIndex, 0, block);
        this.cursor = { scope: 'column', columnsBlockId: cur.columnsBlockId, colIndex: cur.colIndex, index: insertIndex + 1 };
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
          inner.push(BlockRenderer.renderOne(cb, { editable: true }));
          if (cb.id === this.selectedBlockId) {
            inner.push(this.renderInlineProperties(cb));
          }
        }
        if (cursorHere && cur.index >= colBlocks.length) inner.push(slot);
        return inner.join('');
      }
    });
    return styleWrap(block, html);
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

  /** Read the active page style (in-memory draft → saved draft → published → migrated v1). */
  private currentPageStyle(): CommonStyle | undefined {
    return (this.editingPage
      ?? this.listService.getDraftV2()
      ?? this.listService.getPublishedV2()
      ?? this.listService.getPageV2()
    ).style;
  }

  /** Apply the current page style to the live DOM without re-rendering —
   *  keeps input focus during typing. */
  private applyPageStyleToDOM(): void {
    const content = this.container.querySelector('.nospress-page-content') as HTMLElement | null;
    if (!content) return;
    content.style.cssText = buildInlineStyle(schemaFor('page'), this.currentPageStyle());
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

    await this.rerenderEditable();
    const el = this.cursorRow?.getElement();
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('nospress-cursor-row--flash');
      setTimeout(() => el.classList.remove('nospress-cursor-row--flash'), 600);
      this.cursorRow?.focus();
    }
  }

  /** Move cursor INTO an empty column. Triggered by clicking the column's
   *  "Click to add blocks here" placeholder. */
  private async setCursorInColumn(columnsBlockId: string, colIndex: number): Promise<void> {
    this.cursor = { scope: 'column', columnsBlockId, colIndex, index: 0 };
    await this.rerenderEditable();
    const el = this.cursorRow?.getElement();
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('nospress-cursor-row--flash');
      setTimeout(() => el.classList.remove('nospress-cursor-row--flash'), 600);
      this.cursorRow?.focus();
    }
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
    this.listService.saveDraftV2(this.editingPage, { silent: true });
    this.isDirty = false;
    this.refreshActionBar();
    ToastService.show('Saved', 'success');
  }

  private async discardDraft(): Promise<void> {
    const confirmed = await ModalService.getInstance().confirm({
      title: 'Discard draft',
      message: 'This removes all unpublished changes from this device. The page on relays is not affected. Cannot be undone.',
      confirmDestructive: true,
    });
    if (!confirmed) return;
    this.listService.clearDraftV2();
    this.editingPage = null;
    this.isDirty = false;
    ToastService.show('Draft discarded', 'success');
    this.rerenderEditable();
  }

  private async publishDraft(): Promise<void> {
    if (this.isDirty && this.editingPage) {
      // Persist pending edits before publishing
      this.listService.saveDraftV2(this.editingPage, { silent: true });
      this.isDirty = false;
    }
    const draft = this.listService.getDraftV2();
    if (!draft) {
      ToastService.show('No draft to publish', 'error');
      return;
    }

    try {
      await this.orchestrator.publishV2ToRelays(draft);
      this.listService.savePublishedV2(draft);

      this.listService.clearDraftV2();
      this.editingPage = null;
      this.isDirty = false;
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


  /**
   * Update a single style field from an inline input. Generic over scope:
   * 'page' targets the page-level style; 'block:<uuid>' (future) targets a
   * specific block's style. Mutation is silent (no re-render → focus stays
   * on the input); the new style is applied directly to the live DOM.
   */
  private handleStyleInput(scope: string, field: string, rawValue: string): void {
    if (scope === 'page') {
      this.mutateDraft((page) => {
        if (!page.style) page.style = {};
        writeStyleField(page.style, field, rawValue);
      }, { silent: true });
      this.applyPageStyleToDOM();
      return;
    }
    // Block scope: '<blockType>:<uuid>' — only the id portion is needed for
    // lookup; the matrix is keyed by type and resolved inside the renderer.
    const colon = scope.indexOf(':');
    if (colon < 0) return;
    const blockId = scope.slice(colon + 1);
    this.mutateDraft((page) => {
      const loc = findBlockInPage(page, blockId);
      if (!loc) return;
      if (!loc.block.style) loc.block.style = {};
      writeStyleField(loc.block.style, field, rawValue);
    }, { silent: true });
    this.applyBlockStyleToDOM(blockId);
  }

  /** Live-update one block's `data-styled-block-id` wrapper without re-rendering. */
  private applyBlockStyleToDOM(blockId: string): void {
    const el = this.container.querySelector(`[data-styled-block-id="${blockId}"]`) as HTMLElement | null;
    if (!el || !this.editingPage) return;
    const loc = findBlockInPage(this.editingPage, blockId);
    if (!loc) return;
    el.style.cssText = buildInlineStyle(schemaFor(loc.block.type), loc.block.style);
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

      const styleScope = target.dataset?.styleScope;
      const styleField = target.dataset?.styleField;
      if (styleScope && styleField) this.handleStyleInput(styleScope, styleField, target.value);
    });

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
      this.editingPage = JSON.parse(JSON.stringify(
        this.listService.getDraftV2()
          ?? this.listService.getPublishedV2()
          ?? this.listService.getPageV2()
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
      } else if (block.type === 'dm-button') {
        if (field === 'dm-label') block.label = el.value;
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
