import { detectPublicPageRoute, type PublicPageRoute } from './detectPublicPageRoute';
import { resolveNip05 } from './Nip05Resolver';
import { encodeNpub } from '../../services/NostrToolsAdapter';
import { PlatformService } from '../../services/PlatformService';

/**
 * Public-page boot orchestrator. Owns the decision tree for the
 * `noornote.app/{npub}` and `noornote.app/{nip05}` URLs. Used exclusively
 * by App.ts during initialize() — App.ts stays glue.
 *
 *   1. detect()        — top-level URL matches a public-page pattern?
 *   2. mountPublicView — logged-out branch: render PublicNospressPage,
 *                        no MainLayout, no app chrome.
 *   3. resolveToNpub   — logged-in branch: hand back an npub for the
 *                        Router to navigate to /nospress.
 *
 * Browser-only by design (Electron / Capacitor never hit public URLs).
 */
export class PublicPageBootstrap {
  static detect(path?: string): PublicPageRoute | null {
    if (!PlatformService.getInstance().isBrowser) return null;
    return detectPublicPageRoute(path ?? window.location.pathname);
  }

  static async mountPublicView(route: PublicPageRoute, appElement: HTMLElement): Promise<void> {
    document.documentElement.classList.add('layout--public');
    appElement.innerHTML = '';

    // Public-page boot skips App.setupUI(), so the global delegated click
    // handler that powers `.note-image--clickable` lightbox openings is
    // never registered here. Register it explicitly so portfolio (and any
    // future) galleries open the full-screen viewer on the public site
    // exactly like they do inside the in-app editor.
    void import('../../services/ImageClickHandler').then(m => m.getImageClickHandler().init());

    const { PublicNospressPage } = await import('./PublicNospressPage');
    // PublicNospressPage renders directly into `#app` — no extra wrapper.
    // cssScope anchors user CSS to `#app` for the same isolation.
    const view = new PublicNospressPage(route, appElement);
    void view.load();
  }

  static async resolveToNpub(route: PublicPageRoute): Promise<string | null> {
    if (route.type === 'npub') return route.npub;
    const result = await resolveNip05(route.handle);
    return result ? encodeNpub(result.pubkey) : null;
  }
}
