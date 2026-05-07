import { decodeNip19, encodeNpub } from '../../services/NostrToolsAdapter';
import { resolveNip05 } from './Nip05Resolver';
import { NospressOrchestrator } from '../../services/orchestration/NospressOrchestrator';
import { NospressMenuOrchestrator } from '../../services/orchestration/NospressMenuOrchestrator';
import { NospressPageIndexOrchestrator } from '../../services/orchestration/NospressPageIndexOrchestrator';
import { NospressSiteSettingsOrchestrator } from '../../services/orchestration/NospressSiteSettingsOrchestrator';
import type { NospressSiteSettings } from './blocks/siteSettings';
import { UserProfileService, type UserProfile } from '../../services/UserProfileService';
import { ProfileListsComponent } from '../../components/profile/ProfileListsComponent';
import { BlockRenderer } from './blocks/BlockRenderer';
import { buildInlineStyle, schemaFor, sanitizeStyleValue } from './blocks/styles';
import { GLOBAL_HEADER_SLUG, GLOBAL_FOOTER_SLUG, HOME_SLUG, pageHeaderSlug, pageFooterSlug } from './blocks/pageIndex';
import { mountNospressNavMenus } from './navMenuMount';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { extractDisplayName } from '../../helpers/extractDisplayName';
import { showLoggedOutReactionModal } from '../../helpers/LoggedOutModals';
import { AuthService } from '../../services/AuthService';
import { mountNospressEmbeds } from './embedMount';
import { mountNospressProfileCards } from './profileCardMount';
import { mountNospressArticlesLists } from './articlesListMount';
import { mountNospressWeblogs } from './weblogMount';
import { applyUserCss, removeUserCss } from './cssScope';
import type { UserIdentity } from '../../components/shared/UserIdentity';
import type { ProfileArticlesCarousel } from '../../components/profile/ProfileArticlesCarousel';
import type { PublicPageRoute } from './detectPublicPageRoute';
import type { NospressPageV2 } from './blocks/types';

/**
 * Public NosPress page for unauthenticated visitors. Mounted by App.ts's
 * boot path when the URL matches `/{npub}` or `/{nip05}` AND the user is
 * not logged in. Single column, no app chrome (no MainLayout, no sidebar,
 * no SCC). All data is fetched from relays at render time.
 *
 * The path through the App for logged-in users is different: they get
 * redirected to the in-app `/nospress` view (full editor
 * surface). This view is exclusively for visitors from outside.
 */
export class PublicNospressPage {
  private container: HTMLElement;
  private route: PublicPageRoute;
  private inlineMounts: ProfileListsComponent[] = [];
  private profileCardInstances: UserIdentity[] = [];
  private articlesCarousels: ProfileArticlesCarousel[] = [];
  private clickAbort: AbortController | null = null;
  /** Saved values from before site-settings were applied, so destroy() can
   *  restore the document to its pre-public-page state. */
  private savedDocumentTitle: string | null = null;
  private savedCssVariables: Map<string, string> = new Map();
  private savedBodyFontFamily: string | null = null;
  /** Original `<meta>` / `<link>` elements that we replaced during the
   *  public-render. Cloned at remove-time, re-inserted on destroy() so
   *  the in-app head returns to its pre-public state. */
  private savedHeadElements: Element[] = [];
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
    this.container.className = 'user-site';
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

    const orch = NospressOrchestrator.getInstance();
    const menuOrch = NospressMenuOrchestrator.getInstance();
    const pageIndexOrch = NospressPageIndexOrchestrator.getInstance();
    const siteSettingsOrch = NospressSiteSettingsOrchestrator.getInstance();
    // Site composition: parallel fetch of body (per route slug), global
    // header, global footer, plus the menu set + page index for nav-menu
    // blocks. Each lives in its own NIP-78 event. Owner profile is only
    // needed for the empty-state name; the rest informs nav-menu mounting.
    const bodySlug = this.route.slug || HOME_SLUG;
    // Per-page header/footer overrides take precedence over the global slot.
    // We fetch both in parallel and pick the override only when it's non-empty.
    const [profile, body, pageHeader, globalHeader, pageFooter, globalFooter, viewerProfile, menuSet, pageIndex, siteSettings] = await Promise.all([
      UserProfileService.getInstance().getUserProfile(pubkey).catch(() => null),
      orch.fetchFromRelays(pubkey, true, bodySlug).catch(() => null),
      orch.fetchFromRelays(pubkey, true, pageHeaderSlug(bodySlug)).catch(() => null),
      orch.fetchFromRelays(pubkey, true, GLOBAL_HEADER_SLUG).catch(() => null),
      orch.fetchFromRelays(pubkey, true, pageFooterSlug(bodySlug)).catch(() => null),
      orch.fetchFromRelays(pubkey, true, GLOBAL_FOOTER_SLUG).catch(() => null),
      viewerProfilePromise,
      menuOrch.fetchFromRelays(pubkey, true).catch(() => null),
      pageIndexOrch.fetchFromRelays(pubkey, true).catch(() => null),
      siteSettingsOrch.fetchFromRelays(pubkey, true).catch(() => null),
    ]);

    const header = (pageHeader && pageHeader.blocks.length > 0) ? pageHeader : globalHeader;
    const footer = (pageFooter && pageFooter.blocks.length > 0) ? pageFooter : globalFooter;

    // Apply site-settings BEFORE renderPage so theme palette is in place
    // when blocks measure / read computed styles.
    const pageTitleForMeta = body?.title?.trim()
      || pageIndex?.pages.find(p => p.slug === bodySlug)?.title
      || (this.route.type === 'nip05' ? this.route.handle : '');
    this.applySiteSettings(siteSettings, pageTitleForMeta);

    const isEmpty = (p: NospressPageV2 | null): boolean => !p || p.blocks.length === 0;
    if (isEmpty(body) && isEmpty(header) && isEmpty(footer)) {
      this.renderEmpty(profile, viewerProfile);
      return;
    }

    this.renderPage({ body, header, footer, viewerProfile });
    // Body's customCss wins for now — Slice 2 may split header/footer-scoped CSS.
    applyUserCss(body?.customCss ?? '');
    await this.mountInlineBookmarkFolders(pubkey);
    mountNospressEmbeds(this.container);
    this.profileCardInstances = mountNospressProfileCards(this.container, { ownerPubkey: pubkey });
    this.articlesCarousels = mountNospressArticlesLists(this.container, { ownerPubkey: pubkey });
    mountNospressWeblogs(this.container, { ownerPubkey: pubkey });
    if (menuSet && pageIndex) {
      mountNospressNavMenus(this.container, {
        menuSet,
        pageIndex,
        ownerHandle: this.route.type === 'nip05' ? this.route.handle : this.route.npub,
        currentSlug: this.route.slug,
        editorPreview: false,
      });
    }
    this.bindSigningActionCtas();
  }

  public destroy(): void {
    this.clickAbort?.abort();
    this.clickAbort = null;
    this.inlineMounts.forEach(c => c.destroy());
    this.inlineMounts = [];
    this.profileCardInstances.forEach(ui => ui.destroy());
    this.profileCardInstances = [];
    this.articlesCarousels.forEach(c => c.destroy());
    this.articlesCarousels = [];
    removeUserCss();
    this.resetSiteSettings();
    this.container.innerHTML = '';
  }

  /**
   * Apply NosPress site-settings to the document at public-render time.
   *   - `<title>` derived from the title template + page title + site name
   *   - `<meta name="description">`, `og:*`, plus user-defined custom tags
   *   - `<link rel="icon">` for favicon
   *   - `--color-1` … `--color-6` CSS variables on the `<html>` element
   *     (overrides the active app theme for this single page)
   *   - `font-family` on the `<body>` element
   *
   * All injected `<meta>` / `<link>` carry `data-nospress-injected="true"`
   * so {@link resetSiteSettings} can find them on teardown. Pre-existing
   * values for title / CSS variables / font-family are saved for restore.
   */
  private applySiteSettings(settings: NospressSiteSettings | null, pageTitle: string): void {
    if (!settings) return;
    const meta = settings.meta ?? {};
    const theme = settings.theme ?? {};

    // ---- Title ---------------------------------------------------------
    // Format: `<pageTitle> — <siteName>` if both, whichever exists otherwise.
    const siteName = (meta.siteName ?? '').trim();
    const computedTitle = pageTitle && siteName
      ? `${pageTitle} — ${siteName}`
      : (pageTitle || siteName);
    if (computedTitle) {
      if (this.savedDocumentTitle === null) this.savedDocumentTitle = document.title;
      document.title = computedTitle;
    }

    // ---- <meta> tags ---------------------------------------------------
    // We REPLACE existing tags with the same key — most crawlers query the
    // first match (`querySelector('meta[name="description"]')`), so simply
    // appending leaves the NoorNote defaults winning. Originals are saved
    // for destroy()-time restore.
    if (meta.description) {
      this.replaceMetaTag('name', 'description', meta.description);
      this.replaceMetaTag('property', 'og:description', meta.description);
    }
    if (computedTitle) {
      this.replaceMetaTag('property', 'og:title', computedTitle);
      this.replaceMetaTag('name', 'twitter:title', computedTitle);
    }
    if (meta.ogImage) {
      this.replaceMetaTag('property', 'og:image', meta.ogImage);
      this.replaceMetaTag('name', 'twitter:image', meta.ogImage);
      this.replaceMetaTag('name', 'twitter:card', 'summary_large_image');
    }
    (meta.customTags ?? []).forEach(t => {
      const name = t.name?.trim();
      const content = t.content?.trim();
      if (name && content) this.replaceMetaTag('name', name, content);
    });

    // ---- Favicon -------------------------------------------------------
    if (meta.favicon) {
      this.replaceFavicon(meta.favicon);
    }

    // ---- Theme palette + font-family ----------------------------------
    // Run every value through sanitizeStyleValue so a hostile theme cannot
    // smuggle a `url(javascript:…)` payload via a CSS-variable that some
    // downstream rule references.
    const root = document.documentElement;
    if (theme.palette) {
      for (const [key, rawValue] of Object.entries(theme.palette)) {
        if (!rawValue) continue;
        const value = sanitizeStyleValue(rawValue);
        if (!value) continue;
        if (!this.savedCssVariables.has(key)) {
          this.savedCssVariables.set(key, root.style.getPropertyValue(`--${key}`));
        }
        root.style.setProperty(`--${key}`, value);
      }
    }
    if (theme.fontFamily) {
      const ff = sanitizeStyleValue(theme.fontFamily);
      if (ff) {
        if (this.savedBodyFontFamily === null) this.savedBodyFontFamily = document.body.style.fontFamily;
        document.body.style.fontFamily = ff;
      }
    }
  }

  /** Replace any existing `<meta name|property="<key>">` with our own. The
   *  removed originals are saved (cloned) for destroy()-time restore. */
  private replaceMetaTag(attr: 'name' | 'property', key: string, content: string): void {
    const escapedKey = key.replace(/"/g, '\\"');
    document.head.querySelectorAll(`meta[${attr}="${escapedKey}"]`).forEach(el => {
      this.savedHeadElements.push(el.cloneNode(true) as Element);
      el.remove();
    });
    const next = document.createElement('meta');
    next.setAttribute(attr, key);
    next.setAttribute('content', content);
    next.setAttribute('data-nospress-injected', 'true');
    document.head.appendChild(next);
  }

  /** Replace every `<link rel="icon">` (and apple-touch-icon) with our
   *  custom favicon URL. Originals saved for restore. */
  private replaceFavicon(href: string): void {
    document.head.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]').forEach(el => {
      this.savedHeadElements.push(el.cloneNode(true) as Element);
      el.remove();
    });
    const next = document.createElement('link');
    next.setAttribute('rel', 'icon');
    next.setAttribute('href', href);
    next.setAttribute('data-nospress-injected', 'true');
    document.head.appendChild(next);
  }

  /** Restore the document to its pre-public-page state. Removes every
   *  injected meta/link, re-inserts the originals we replaced, restores
   *  CSS variables, title, and body font. */
  private resetSiteSettings(): void {
    if (this.savedDocumentTitle !== null) {
      document.title = this.savedDocumentTitle;
      this.savedDocumentTitle = null;
    }
    document.head.querySelectorAll('[data-nospress-injected="true"]').forEach(el => el.remove());
    this.savedHeadElements.forEach(el => document.head.appendChild(el));
    this.savedHeadElements = [];
    this.savedCssVariables.forEach((value, key) => {
      if (value) document.documentElement.style.setProperty(`--${key}`, value);
      else document.documentElement.style.removeProperty(`--${key}`);
    });
    this.savedCssVariables.clear();
    if (this.savedBodyFontFamily !== null) {
      document.body.style.fontFamily = this.savedBodyFontFamily;
      this.savedBodyFontFamily = null;
    }
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
    this.container.innerHTML = `<div class="user-site__loading pulsate">Loading…</div>`;
  }

  private renderError(): void {
    this.container.innerHTML = `
      <div class="user-site__error">
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
      <div class="user-site__empty">
        <p>${escapeHtml(name) || 'This user'} has no NosPress page yet.</p>
      </div>
      ${this.footerHtml()}
    `;
  }

  private renderPage(parts: {
    body: NospressPageV2 | null;
    header: NospressPageV2 | null;
    footer: NospressPageV2 | null;
    viewerProfile: UserProfile | null;
  }): void {
    const { body, header, footer, viewerProfile } = parts;

    const headerHtml = header && header.blocks.length > 0
      ? `<header class="user-site__site-header">${BlockRenderer.renderAll(header.blocks, { editable: false })}</header>`
      : '';

    const footerHtml = footer && footer.blocks.length > 0
      ? `<footer class="user-site__site-footer">${BlockRenderer.renderAll(footer.blocks, { editable: false })}</footer>`
      : '';

    // Page-level inline style (color/background/padding etc.) applies to the
    // body's main content, not the global header/footer (those have their
    // own styles in Slice 2 — for now they inherit the site bg).
    const bodyBlocksHtml = body && body.blocks.length > 0
      ? BlockRenderer.renderAll(body.blocks, { editable: false })
      : '';
    const inlineStyle = body ? buildInlineStyle(schemaFor('page'), body.style) : '';
    const styleAttr = inlineStyle ? ` style="${escapeHtmlAttr(inlineStyle)}"` : '';
    const bodyHtml = bodyBlocksHtml
      ? `<main class="user-site__site-body"><div class="layout-wrapper"${styleAttr}>${bodyBlocksHtml}</div></main>`
      : '';

    this.container.innerHTML = `
      ${this.adminBarHtml(viewerProfile)}
      ${headerHtml}
      ${bodyHtml}
      ${footerHtml}
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
    // Carry the current page slug into the editor so "Edit page →" lands on
    // the page the visitor is actually looking at.
    const editPageQuery = this.route.slug ? `?page=${encodeURIComponent(this.route.slug)}` : '';
    const editLink = isOwner
      ? `<a class="user-site-bar__link user-site-bar__link--accent" href="/nospress${editPageQuery}">Edit page →</a>`
      : '';

    const name = viewerProfile ? extractDisplayName(viewerProfile) : '';
    const picture = viewerProfile?.picture ?? '';
    const avatar = picture
      ? `<img class="user-site-bar__avatar" src="${escapeHtmlAttr(picture)}" alt="" />`
      : '';

    return `
      <div class="user-site-bar">
        <nav class="user-site-bar__nav">
          <a class="user-site-bar__brand" href="/">NoorNote</a>
          <a class="user-site-bar__link" href="/notifications">Notifications</a>
          <a class="user-site-bar__link" href="/messages">Messages</a>
          ${editLink}
        </nav>
        <a class="user-site-bar__user" href="/profile/${this.viewerNpub}">
          ${avatar}
          <span class="user-site-bar__name">${escapeHtml(name)}</span>
        </a>
      </div>
    `;
  }


  private footerHtml(): string {
    // Platform attribution — NOT the user's page footer. Wrapped in <small>
    // (the HTML5 element for footer-style fine print) so the only <footer>
    // on the page is the user's own one.
    return `
      <div class="user-site__footer">
        <small>Made with <a href="/">NoorNote</a> — sovereign personal pages on Nostr.</small>
      </div>
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
