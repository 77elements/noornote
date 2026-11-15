/**
 * Canonical share/deep-link URLs (pure logic, no imports).
 *
 * Share links must always point at the production web app, NOT at the
 * environment the user happens to run: on Electron `window.location.origin`
 * is `file://`, in local dev it is `http://localhost:3000` — both produce
 * unopenable links for the recipient. Deep links (/note/<nevent>,
 * /article/<naddr>) resolve identically on noornote.app regardless of where
 * the share was created.
 */

export const CANONICAL_APP_ORIGIN = 'https://noornote.app';

/**
 * Build a canonical share URL for an app-relative deep-link path
 * (e.g. `/note/<nevent>`, `/article/<naddr>`).
 */
export function canonicalShareUrl(path: string): string {
  return `${CANONICAL_APP_ORIGIN}${path.startsWith('/') ? path : `/${path}`}`;
}
