/**
 * Profile Recognition addon runtime.
 *
 * Loaded dynamically by AddonLoader only when the addon flag is ON. The
 * static imports below are the SINGLE entry point pulling the heavy
 * ProfileRecognitionService + profileBlinking modules into their chunk.
 * Core call sites (ContentProcessor, UserIdentity, ProfileView, RepostRenderer)
 * use only `import type { ProfileRecognitionRuntime }` — type-only, erased at
 * build time — and fetch the live runtime via
 * `AddonLoader.getInstance().getRuntime<ProfileRecognitionRuntime>('profile-recognition')`.
 *
 * Destroy contract:
 *   - call ProfileRecognitionService.destroy() which:
 *       - clears fileSaveTimeout + relaySaveTimeout
 *       - unsubscribes the 'follow:updated' EventBus listener
 *       - resets `initialized` and releases the static singleton instance
 *   - null the runtime's service and class references so GC can reclaim them
 *
 * Why this matters: the old pattern lazy-loaded the service from five
 * different call sites, each cached a reference, and nothing ever stopped
 * the debounced timeouts or the follow:updated listener on account switch.
 * Encounter data could leak across accounts. Now the AddonLoader owns the
 * full lifecycle.
 */

import type { AddonContext, AddonRuntime } from '../AddonLoader';
import type { ProfileRecognitionService as Service } from './ProfileRecognitionService';
import type {
  ProfileBlinker as ProfileBlinkerT,
  TextBlinker as TextBlinkerT,
} from './profileBlinking';

export class ProfileRecognitionRuntime implements AddonRuntime {
  public service: Service | null = null;
  public ProfileBlinker:
    | (new (el: HTMLImageElement) => ProfileBlinkerT)
    | null = null;
  public TextBlinker: (new (el: HTMLElement) => TextBlinkerT) | null = null;

  async init(_ctx: AddonContext): Promise<void> {
    if (this.service) return; // idempotent

    const [{ ProfileRecognitionService }, { ProfileBlinker, TextBlinker }] =
      await Promise.all([
        import('./ProfileRecognitionService'),
        import('./profileBlinking'),
      ]);

    this.service = ProfileRecognitionService.getInstance();
    this.ProfileBlinker = ProfileBlinker;
    this.TextBlinker = TextBlinker;

    // Run the encounter-load cascade (localStorage → file → relays).
    // Idempotent inside the service via its own `initialized` flag.
    await this.service.init();
  }

  async destroy(): Promise<void> {
    if (!this.service) return;
    this.service.destroy();
    this.service = null;
    this.ProfileBlinker = null;
    this.TextBlinker = null;
  }
}

export default new ProfileRecognitionRuntime();
