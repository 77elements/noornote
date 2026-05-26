/**
 * AboutView Component
 * Imprint and Privacy Policy (German legal requirements)
 *
 * @purpose Display legal information required by German law (§5 TMG)
 * @used-by App.ts
 */

import { View } from './View';
import { PlatformService } from '../../services/PlatformService';
import { UserProfileService } from '../../services/UserProfileService';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { SettingsModuleApi } from '../../modules/settings/contracts';
import { renderUserMention, setupUserMentionHandlers } from '../../helpers/UserMentionHelper';
import { extractDisplayName } from '../../helpers/extractDisplayName';
import { npubToHex } from '../../helpers/nip19';

declare const __APP_VERSION__: string;

interface CreditEntry {
  product: string;
  productUrl: string;
  /** Use UserMentionHelper when present. */
  npub?: string;
  /** Plain author name + URL fallback for non-Nostr authors. */
  authorName?: string;
  authorUrl?: string;
}

const CREDITS: CreditEntry[] = [
  {
    product: 'Follow Packs',
    productUrl: 'https://github.com/callebtc/following.space',
    npub: 'npub12rv5lskctqxxs2c8rf2zlzc7xx3qpvzs3w4etgemauy9thegr43sf485vg',
  },
  {
    product: 'Video / Image / Audio Compression',
    productUrl: 'https://github.com/iefanx/nostr-compress',
    npub: 'npub1cmmswlckn82se7f2jeftl6ll4szlc6zzh8hrjyyfm9vm3t2afr7svqlr6f',
  },
  {
    product: 'Hijri Calendar (dayjs-calendarsystems)',
    productUrl: 'https://github.com/calidy-com/dayjs-calendarsystems',
    authorName: 'Calidy',
    authorUrl: 'https://calidy.com/',
  },
];

export class AboutView extends View {
  private container: HTMLElement;
  private platform = PlatformService.getInstance();

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--about';
    this.render();
    this.bindListeners();
    void this.populateCredits();
  }

  private render(): void {
    this.container.innerHTML = `
      <h1 class="about-title">About NoorNote</h1>

        <section class="about-section">
          <h2>Imprint</h2>
          <p><strong>[ mslm dvlpmnt ]</strong></p>
          <p>Am Engeldorfer Berg 11<br>50997 Cologne<br>Germany</p>
          <p>
            Email: <a href="mailto:contact@mslmdvlpmnt.com">contact@mslmdvlpmnt.com</a><br>
            Phone: +49 1577 2456227
          </p>
        </section>

        <section class="about-section">
          <h2>Hire Me</h2>
          <p>
            Need help with your web project? I'm available for hire — design, UX, and development. Sats accepted.<br>
            <a href="https://mslmdvlpmnt.com/" rel="noopener noreferrer">mslmdvlpmnt.com</a> · <a href="/profile/npub175nul9cvufswwsnpy99lvyhg7ad9nkccxhkhusznxfkr7e0zxthql9g6w0">DM me on Nostr</a>
          </p>
        </section>

        <section class="about-section">
          <h2>Privacy Policy</h2>

          <h3>Responsible Party</h3>
          <p>[ mslm dvlpmnt ], Am Engeldorfer Berg 11, 50997 Cologne, Germany</p>

          ${this.renderDataStorageSection()}

          ${this.renderWebHostingSection()}

          <h3>Connections to Nostr Relays</h3>
          <p>
            All content you create (notes, articles, profile information, etc.) is stored on
            Nostr relays, not on your device or our servers. NoorNote simply connects to these
            relays to read and publish your content.
          </p>
          <p>
            Nostr relays are operated by third parties. When connecting, your IP address
            may be logged by the relay operators. The choice of relays is yours
            and can be configured in the settings.
          </p>

          ${this.renderThirdPartySection()}

          <h3>No Tracking or Analytics by NoorNote</h3>
          <p>
            NoorNote does not use any analytics services, tracking pixels, marketing cookies,
            or telemetry. We do not collect, log, or transmit any usage data to ourselves.
            The third-party connections described above are inherent to rendering content and
            providing the service — they are not telemetry, and no identifier beyond a standard
            HTTP request (IP, User-Agent) is sent.
          </p>

          <h3>Your Rights</h3>
          <p>
            Since we do not store or process any personal data, the usual GDPR data subject rights
            do not apply. For questions, you can contact us at
            <a href="mailto:contact@mslmdvlpmnt.com">contact@mslmdvlpmnt.com</a>.
          </p>
        </section>

        <section class="about-section">
          <h2>Open Source</h2>
          <p>
            NoorNote and NoorSigner are free and open source software, released under the
            <a href="https://opensource.org/licenses/MIT" rel="noopener noreferrer">MIT License</a>.
          </p>
        </section>

        <section class="about-section">
          <h2>Credits</h2>
          <p>NoorNote integrates third-party open-source work. Thanks to:</p>
          <ul>
            ${CREDITS.map(c => {
              const author = c.npub
                ? `<span data-credit-mention data-pubkey="${npubToHex(c.npub) ?? ''}"></span>`
                : `<a href="${c.authorUrl ?? '#'}" rel="noopener noreferrer">${c.authorName ?? ''}</a>`;
              return `
                <li>
                  <a href="${c.productUrl}" rel="noopener noreferrer">${c.product}</a>
                  by ${author}
                </li>
              `;
            }).join('')}
          </ul>
          <p>
            Special thanks to <span data-credit-mention data-pubkey="${npubToHex('npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6') ?? ''}"></span>
            for inventing the Nostr protocol, and to all <a href="https://github.com/nostr-protocol/nips" rel="noopener noreferrer">NIP</a>
            authors and other Nostr devs for the inspiration.
          </p>
          <p>
            And finally, thanks to every user who actively shapes NoorNote with feedback and support.
          </p>
          <p lang="ar" dir="rtl" class="about-section__doxology">وَلِلَّهِ الْحَمْد</p>
        </section>

        <section class="about-section">
          <h2>Version</h2>
          <p>NoorNote v${__APP_VERSION__}</p>
          ${this.platform.isDesktop ? '<button class="btn btn--mini" id="about-check-update-btn">Check for updates</button>' : ''}
        </section>

        <section class="about-section about-section--footer">
          <p>NoorNote - A Nostr Client</p>
        </section>
    `;
  }

  private renderDataStorageSection(): string {
    if (this.platform.isAndroid) {
      return `
        <h3>Data Storage</h3>
        <p>
          NoorNote is a mobile app that stores all data locally on your device:
        </p>
        <ul>
          <li><strong>Key Storage:</strong> Your private key is managed by Amber (NIP-55 signer) and never shared with NoorNote.</li>
          <li><strong>Cache:</strong> Temporary data is stored in your device's IndexedDB and localStorage.</li>
        </ul>
        <p>
          <strong>We have no access to your data.</strong> All data remains on your device.
        </p>`;
    }

    if (this.platform.isBrowser) {
      return `
        <h3>Data Storage</h3>
        <p>
          NoorNote is a web application. All data stays in your browser:
        </p>
        <ul>
          <li><strong>Key Storage:</strong> Your private key is managed by your browser extension (e.g. Alby) and never shared with NoorNote or our server.</li>
          <li><strong>Cache:</strong> Temporary data is stored in your browser's IndexedDB and localStorage.</li>
          <li><strong>No User-Data Storage on Our Server:</strong> Our web host serves the static application bundle. We do not store, process, or have access to any user data on the server itself.</li>
        </ul>
        <p>
          <strong>We have no access to your data.</strong> All user data remains in your browser and can be cleared at any time via your browser settings.
        </p>`;
    }

    return `
      <h3>Local Data Storage</h3>
      <p>
        NoorNote is a desktop application that stores all data locally on your device:
      </p>
      <ul>
        <li><strong>Key Storage:</strong> Your private key (nsec) is stored in your operating system's keychain (macOS Keychain, Linux Secret Service).</li>
        <li><strong>Cache:</strong> Temporary data is stored in IndexedDB and localStorage.</li>
        <li><strong>Configuration Files:</strong> Settings are stored in the <code>~/.noornote/</code> directory.</li>
      </ul>
      <p>
        <strong>We have no access to this data.</strong> All data remains on your device.
      </p>`;
  }

  private renderWebHostingSection(): string {
    if (!this.platform.isBrowser) return '';
    return `
      <h3>Web Hosting</h3>
      <p>
        The web version of NoorNote (<a href="https://noornote.app" rel="noopener noreferrer">noornote.app</a>) is hosted by
        <strong>Mynymbox Hosting LLC</strong>, Hamilton Development, Unit B, Charlestown,
        Nevis, West Indies, St. Kitts and Nevis
        (<a href="https://mynymbox.io/privacypolicy" rel="noopener noreferrer">Privacy Policy</a>).
        Like any web host, MyNymbox processes standard server log data when you load the
        application — typically your IP address, request timestamp, the URL/file requested,
        browser type, and referrer — for operational and security purposes (e.g. DDoS
        mitigation, server stability). NoorNote itself does not access or use these logs.
      </p>
      <p>
        <strong>Third country notice:</strong> St. Kitts and Nevis is not covered by an EU
        adequacy decision (Art. 45 GDPR). Any transfer to MyNymbox's servers takes place
        on the basis of the derogations of Art. 49 (1) GDPR.
      </p>`;
  }

  private renderThirdPartySection(): string {
    const desktopUpdateItem = this.platform.isDesktop
      ? `<li><strong>Update check:</strong> The desktop version periodically queries <code>api.github.com</code> to detect new releases. GitHub is operated by GitHub, Inc., 88 Colin P Kelly Jr Street, San Francisco, CA 94107, USA.</li>`
      : '';
    const browserProxyItem = this.platform.isBrowser
      ? `<li><strong>Media proxy:</strong> When loading images embedded in notes, NoorNote may route the request through a proxy operated by us at <code>noornote-proxy.77elements.deno.net</code> (running on Deno Deploy, Deno Land Inc., USA) to bypass CORS restrictions of the original image host. The proxy forwards your request to the third-party image host.</li>`
      : '';
    return `
      <h3>Other Third-Party Connections</h3>
      <p>
        Beyond Nostr relays, NoorNote makes network requests to a small set of third-party
        endpoints to render content correctly. Each request unavoidably exposes your IP
        address to the receiving service:
      </p>
      <ul>
        <li><strong>NIP-05 verification:</strong> When verifying a user's NIP-05 identifier (e.g. <code>alice@example.com</code>), NoorNote sends an HTTP request to <code>https://example.com/.well-known/nostr.json</code>. The owner of that domain may log the request.</li>
        <li><strong>Profile pictures and embedded media:</strong> Avatars, images, videos, and audio referenced in Nostr events are loaded directly from whatever URL the author published. Each such load is a direct request from your device to that third-party host.</li>
        ${browserProxyItem}
        <li><strong>Scheduled Posts (optional addon):</strong> When the Scheduled Posts addon is enabled, your scheduled events are temporarily stored on a service operated by us at <code>noornote-scheduler.77elements.deno.net</code> (running on Deno Deploy, Deno Land Inc., USA) until their scheduled release time.</li>
        ${desktopUpdateItem}
      </ul>`;
  }

  private bindListeners(): void {
    const checkUpdateBtn = this.container.querySelector('#about-check-update-btn');
    checkUpdateBtn?.addEventListener('click', async () => {
      const settingsApi = ModuleLoader.getInstance().getApi<SettingsModuleApi>('settings');
      await settingsApi?.checkUpdateManually(checkUpdateBtn as HTMLButtonElement);
    });
  }

  private async populateCredits(): Promise<void> {
    const placeholders = this.container.querySelectorAll<HTMLElement>('[data-credit-mention][data-pubkey]');
    if (placeholders.length === 0) return;

    const profileService = UserProfileService.getInstance();
    await Promise.all(Array.from(placeholders).map(async (el) => {
      const pubkey = el.dataset.pubkey;
      if (!pubkey) return;
      const profile = await profileService.getUserProfile(pubkey);
      const username = extractDisplayName(profile) || pubkey.slice(0, 8);
      el.outerHTML = renderUserMention(pubkey, {
        username,
        avatarUrl: profile.picture ?? '',
      });
    }));

    setupUserMentionHandlers(this.container);
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.container.remove();
  }
}
