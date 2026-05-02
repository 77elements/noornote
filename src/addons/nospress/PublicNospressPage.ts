import { decodeNip19 } from '../../services/NostrToolsAdapter';
import { resolveNip05 } from './Nip05Resolver';
import { NospressOrchestrator } from '../../services/orchestration/NospressOrchestrator';
import { UserProfileService, type UserProfile } from '../../services/UserProfileService';
import { ProfileListsComponent } from '../../components/profile/ProfileListsComponent';
import { BlockRenderer } from './blocks/BlockRenderer';
import { buildInlineStyle, schemaFor } from './blocks/styles';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { extractDisplayName } from '../../helpers/extractDisplayName';
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

  constructor(route: PublicPageRoute) {
    this.route = route;
    this.container = document.createElement('div');
    this.container.className = 'public-page';
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

    const [profile, page] = await Promise.all([
      UserProfileService.getInstance().getUserProfile(pubkey).catch(() => null),
      NospressOrchestrator.getInstance().fetchFromRelays(pubkey, true).catch(() => null),
    ]);

    if (!page || page.blocks.length === 0) {
      this.renderEmpty(profile);
      return;
    }

    this.renderPage(profile, page);
    await this.mountInlineBookmarkFolders(pubkey);
  }

  public destroy(): void {
    this.inlineMounts.forEach(c => c.destroy());
    this.inlineMounts = [];
    this.container.innerHTML = '';
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

  private renderEmpty(profile: UserProfile | null): void {
    const name = profile ? extractDisplayName(profile) : '';
    this.container.innerHTML = `
      ${this.headerHtml(profile)}
      <div class="public-page__empty">
        <p>${escapeHtml(name) || 'This user'} has no NosPress page yet.</p>
      </div>
      ${this.footerHtml()}
    `;
  }

  private renderPage(profile: UserProfile | null, page: NospressPageV2): void {
    const blocksHtml = BlockRenderer.renderAll(page.blocks, { editable: false });
    const inlineStyle = buildInlineStyle(schemaFor('page'), page.style);
    const styleAttr = inlineStyle ? ` style="${escapeHtmlAttr(inlineStyle)}"` : '';

    this.container.innerHTML = `
      ${this.headerHtml(profile)}
      <div class="public-page__content"${styleAttr}>${blocksHtml}</div>
      ${this.footerHtml()}
    `;
  }

  private headerHtml(profile: UserProfile | null): string {
    const name = profile ? extractDisplayName(profile) : '';
    const picture = profile?.picture ?? '';
    const nip05 = profile?.nip05 ?? '';
    return `
      <header class="public-page__header">
        ${picture ? `<img class="public-page__avatar" src="${escapeHtmlAttr(picture)}" alt="" />` : ''}
        <div class="public-page__identity">
          <h1 class="public-page__name">${escapeHtml(name)}</h1>
          ${nip05 ? `<p class="public-page__nip05">${escapeHtml(nip05)}</p>` : ''}
        </div>
      </header>
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
