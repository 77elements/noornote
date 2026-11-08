/**
 * Live Streams addon runtime (AddonLoader lifecycle).
 *
 * Owns the sidebar "currently live" widget for followed users; torn down by
 * destroy() so the refresh interval and DOM nodes never leak across
 * logout / account-switch / toggle-off. The addon page (stream list + switches)
 * is owned by LiveStreamsAddonView instead. The inline HLS player (player.ts +
 * hls.js) stays on-demand: it is dynamically imported by
 * ArticlePreviewRenderer.upgradeToInlinePlayer() when a live-stream card is
 * actually played — never loaded by this runtime.
 */

import type { AddonContext, AddonRuntime } from '../AddonLoader';
import { diagLog } from '../../services/DiagnosticLogger';
import { LiveStreamsSidebarWidget } from './LiveStreamsSidebarWidget';
import { LiveStreamsMiniPlayerWidget } from './LiveStreamsMiniPlayerWidget';
import { backgroundPlayer } from './backgroundPlayer';
import { isLiveStreamsEnabled, isLiveStreamsSidebarWidget } from './index';

export class LiveStreamsRuntime implements AddonRuntime {
  private initialized = false;
  /** Public so the addon view can refresh it live via AddonLoader.getRuntime(). */
  public widget: LiveStreamsSidebarWidget | null = null;
  /** Sidebar mini player for the pinned background stream. */
  public miniPlayer: LiveStreamsMiniPlayerWidget | null = null;

  async init(ctx: AddonContext): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    // Restore the persisted background-stream pin (paused) for this account.
    backgroundPlayer.restore();

    this.widget = new LiveStreamsSidebarWidget({
      container: () =>
        document.querySelector('[data-sidebar-widget="live-streams"]'),
      visible: () => isLiveStreamsEnabled() && isLiveStreamsSidebarWidget(),
    });
    this.widget.mount();
    this.miniPlayer = new LiveStreamsMiniPlayerWidget();
    diagLog('addons', 'live-streams: runtime init', {
      npub: ctx.npub?.slice(0, 12),
    });
  }

  async destroy(): Promise<void> {
    if (!this.initialized) return;
    this.initialized = false;
    backgroundPlayer.destroy();
    this.widget?.destroy();
    this.widget = null;
    this.miniPlayer?.destroy();
    this.miniPlayer = null;
    diagLog('addons', 'live-streams: runtime destroy');
  }
}

export default new LiveStreamsRuntime();
