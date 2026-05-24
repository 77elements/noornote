/**
 * Web Update Banner — manual trigger for hard-refresh notification.
 *
 * When BUILD_NOTICE_ID is non-empty and the user hasn't dismissed it,
 * a banner appears in the sidebar prompting them to refresh.
 * Claude sets the ID when instructed ("Banner aktivieren" / "Hard refresh aktivieren").
 */

export const BUILD_NOTICE_ID = '2026-05-24-1';

const STORAGE_KEY = 'noornote_seen_build_notice';

export function mountUpdateBanner(): void {
  if (!BUILD_NOTICE_ID) return;

  const seen = localStorage.getItem(STORAGE_KEY);
  if (seen === BUILD_NOTICE_ID) return;

  const anchor = document.querySelector('.current-datetime-display');
  if (!anchor) return;

  const banner = document.createElement('div');
  banner.className = 'update-banner';
  banner.innerHTML = `
    <span class="update-banner__text">New version online. Press refresh.</span>
    <button class="btn btn--medium update-banner__refresh">Refresh</button>
  `;

  anchor.insertAdjacentElement('afterend', banner);

  banner.querySelector('.update-banner__refresh')?.addEventListener('click', async () => {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    localStorage.setItem(STORAGE_KEY, BUILD_NOTICE_ID);
    window.location.reload();
  });

}

if (import.meta.env.DEV) {
  (window as any).__activateUpdateBanner = () => {
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  };
}
