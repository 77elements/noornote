import { decodeNip19, encodeNpub } from '../../services/NostrToolsAdapter';
import { resolveNip05 } from './Nip05Resolver';
import { NospressOrchestrator } from '../../services/orchestration/NospressOrchestrator';
import { UserProfileService, type UserProfile } from '../../services/UserProfileService';
import { ProfileListsComponent } from '../../components/profile/ProfileListsComponent';
import { BlockRenderer } from './blocks/BlockRenderer';
import { buildInlineStyle, schemaFor } from './blocks/styles';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { extractDisplayName } from '../../helpers/extractDisplayName';
import { showLoggedOutReactionModal } from '../../helpers/LoggedOutModals';
import { AuthService } from '../../services/AuthService';
import { mountNospressEmbeds } from './embedMount';
import { mountNospressProfileCards } from './profileCardMount';
import type { UserIdentity } from '../../components/shared/UserIdentity';
import type { PublicPageRoute } from './detectPublicPageRoute';
import type { NospressPageV2 } from './blocks/types';

/**
 * Public NosPress page for unauthenticated visitors. Mounted by App.ts's
 * boot path when the URL matches `/{npub}` or `/{nip05}` AND the user is
 * not logged in. Single column, no app chrome (no MainLayout, no sidebar,
 * no SCC). All data is fetched from relays at render time.
 *
 * The path through the App for logged-in users is different: they get
 * redirected to the in-app `/profile/{npub}/nospress` view (full editor
 * surface). This view is exclusively for visitors from outside.
 */
export class PublicNospressPage {
  private container: HTMLElement;
  private route: PublicPageRoute;
  private inlineMounts: ProfileListsComponent[] = [];
  private profileCardInstances: UserIdentity[] = [];
  private clickAbort: AbortController | null = null;
  /** Owner of the page (= page author). Resolved from the route during load,
   *  reused by the signing-action CTAs to build action-specific post-login
   *  redirects (e.g. dm-button → /messages/{ownerNpub}). */
  private ownerNpub: string | null = null;
  /** Viewer (= currently logged-in NoorNote user, if any). Drives the
   *  WordPress-style admin bar at the top of the page and turns signing-
   *  action CTAs into direct navigations instead of logged-out modals. */
  private readonly viewerNpub: string | null;
  private readonly viewerPubkey: string | null;

  /**
   * Map of `data-action` → reaction-type for the logged-out CTA modal.
   * Every signing-required action emitted by a block renderer must have an
   * entry here; otherwise the click silently no-ops on the public view.
   * Add a new entry whenever a new block-type with signing actions ships.
   */
  private static readonly SIGNING_ACTIONS: Record<string, string> = {
    'dm-page-owner': 'dm',
  };

  constructor(route: PublicPageRoute) {
    this.route = route;
    this.container = document.createElement('div');
    this.container.className = 'public-page';
    const viewer = AuthService.getInstance().getCurrentUser();
    this.viewerNpub = viewer?.npub ?? null;
    this.viewerPubkey = viewer?.pubkey ?? null;
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public async load(): Promise<void> {
    this.renderLoading();

    const pubkey = await this.resolvePubkey();
    if (!pubkey) {
      this.renderError();
      return;
    }
    this.ownerNpub = encodeNpub(pubkey);

    const viewerProfilePromise = this.viewerPubkey
      ? UserProfileService.getInstance().getUserProfile(this.viewerPubkey).catch(() => null)
      : Promise.resolve(null);

    const [profile, page, viewerProfile] = await Promise.all([
      UserProfileService.getInstance().getUserProfile(pubkey).catch(() => null),
      NospressOrchestrator.getInstance().fetchFromRelays(pubkey, true).catch(() => null),
      viewerProfilePromise,
    ]);

    if (!page || page.blocks.length === 0) {
      this.renderEmpty(profile, viewerProfile);
      return;
    }

    this.renderPage(profile, page, viewerProfile);
    await this.mountInlineBookmarkFolders(pubkey);
    mountNospressEmbeds(this.container);
    this.profileCardInstances = mountNospressProfileCards(this.container, { ownerPubkey: pubkey });
    this.bindSigningActionCtas();
  }

  public destroy(): void {
    this.clickAbort?.abort();
    this.clickAbort = null;
    this.inlineMounts.forEach(c => c.destroy());
    this.inlineMounts = [];
    this.profileCardInstances.forEach(ui => ui.destroy());
    this.profileCardInstances = [];
    this.container.innerHTML = '';
  }

  /**
   * Delegated click handler on the page root: any `data-action` listed in
   * SIGNING_ACTIONS opens the logged-out CTA modal with the matching
   * reaction-type. Single AbortController owns the listener so destroy()
   * cleanly removes it.
   */
  private bindSigningActionCtas(): void {
    this.clickAbort?.abort();
    this.clickAbort = new AbortController();
    this.container.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      const trigger = target?.closest('[data-action]') as HTMLElement | null;
      if (!trigger) return;
      const action = trigger.dataset.action ?? '';
      const reactionType = PublicNospressPage.SIGNING_ACTIONS[action];
      if (!reactionType) return;
      e.preventDefault();
      e.stopPropagation();
      const postLoginAction = this.postLoginActionFor(action);

      // Logged-in viewer: skip the CTA modal and route directly to the
      // action target (e.g. /messages/{owner}). Full reload because there
      // is no MainLayout in the public-view DOM to mount the in-app view
      // into — App.ts's boot path handles the next page cleanly.
      if (this.viewerPubkey) {
        if (postLoginAction) {
          window.location.href = postLoginAction;
        }
        return;
      }

      showLoggedOutReactionModal(reactionType, postLoginAction ? { postLoginAction } : {});
    }, { signal: this.clickAbort.signal });
  }

  /**
   * Map a block-emitted `data-action` to the URL the user should land on
   * after a successful login. Returns undefined when the action has no
   * action-specific destination (e.g. a generic Like/Reply on an Embed —
   * those land back on the Embed itself, which is the current page).
   */
  private postLoginActionFor(action: string): string | undefined {
    if (action === 'dm-page-owner' && this.ownerNpub) {
      return `/messages/${this.ownerNpub}`;
    }
    return undefined;
  }

  private async resolvePubkey(): Promise<string | null> {
    if (this.route.type === 'npub') {
      try {
        const decoded = decodeNip19(this.route.npub);
        return decoded.type === 'npub' ? (decoded.data as string) : null;
      } catch {
        return null;
      }
    }
    const result = await resolveNip05(this.route.handle);
    return result?.pubkey ?? null;
  }

  private renderLoading(): void {
    this.container.innerHTML = `<div class="public-page__loading pulsate">Loading…</div>`;
  }

  private renderError(): void {
    this.container.innerHTML = `
      <div class="public-page__error">
        <h1>Page not found</h1>
        <p>This handle could not be resolved.</p>
        <p><a href="/">noornote.app</a></p>
      </div>
    `;
  }

  private renderEmpty(profile: UserProfile | null, viewerProfile: UserProfile | null): void {
    const name = profile ? extractDisplayName(profile) : '';
    this.container.innerHTML = `
      ${this.adminBarHtml(viewerProfile)}
      <div class="public-page__empty">
        <p>${escapeHtml(name) || 'This user'} has no NosPress page yet.</p>
      </div>
      ${this.footerHtml()}
    `;
  }

  private renderPage(_profile: UserProfile | null, page: NospressPageV2, viewerProfile: UserProfile | null): void {
    const blocksHtml = BlockRenderer.renderAll(page.blocks, { editable: false });
    const inlineStyle = buildInlineStyle(schemaFor('page'), page.style);
    const styleAttr = inlineStyle ? ` style="${escapeHtmlAttr(inlineStyle)}"` : '';

    this.container.innerHTML = `
      ${this.adminBarHtml(viewerProfile)}
      <div class="public-page__content"${styleAttr}>${blocksHtml}</div>
      ${this.footerHtml()}
    `;
  }

  /**
   * WordPress-style admin bar shown only when a NoorNote user is logged in.
   * Quick-nav back into the app + viewer identity. When the viewer is the
   * page owner, an extra "Edit page" link appears that jumps to the
   * fullscreen editor.
   */
  private adminBarHtml(viewerProfile: UserProfile | null): string {
    if (!this.viewerNpub) return '';

    const isOwner = this.ownerNpub !== null && this.ownerNpub === this.viewerNpub;
    const editLink = isOwner
      ? `<a class="public-page-bar__link public-page-bar__link--accent" href="/profile/${this.viewerNpub}/nospress/edit/fullscreen">Edit page →</a>`
      : '';

    const name = viewerProfile ? extractDisplayName(viewerProfile) : '';
    const picture = viewerProfile?.picture ?? '';
    const avatar = picture
      ? `<img class="public-page-bar__avatar" src="${escapeHtmlAttr(picture)}" alt="" />`
      : '';

    return `
      <div class="public-page-bar">
        <nav class="public-page-bar__nav">
          <a class="public-page-bar__brand" href="/">NoorNote</a>
          <a class="public-page-bar__link" href="/notifications">Notifications</a>
          <a class="public-page-bar__link" href="/messages">Messages</a>
          ${editLink}
        </nav>
        <a class="public-page-bar__user" href="/profile/${this.viewerNpub}">
          ${avatar}
          <span class="public-page-bar__name">${escapeHtml(name)}</span>
        </a>
      </div>
    `;
  }


  private footerHtml(): string {
    return `
      <footer class="public-page__footer">
        <p>Made with <a href="/">NoorNote</a> — sovereign personal pages on Nostr.</p>
      </footer>
    `;
  }

  private async mountInlineBookmarkFolders(pubkey: string): Promise<void> {
    const slots = this.container.querySelectorAll<HTMLElement>('.nospress-bookmark-folder-mount');
    for (const slot of Array.from(slots)) {
      const folderName = slot.dataset.folderName;
      if (!folderName) continue;
      const component = new ProfileListsComponent(pubkey, 'nospress');
      this.inlineMounts.push(component);
      await component.render(slot, [folderName]);
    }
  }
}
