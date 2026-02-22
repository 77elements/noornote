/**
 * AboutView Component
 * Imprint and Privacy Policy (German legal requirements)
 *
 * @purpose Display legal information required by German law (§5 TMG)
 * @used-by App.ts
 */

import { View } from './View';
import { PlatformService } from '../../services/PlatformService';

declare const __APP_VERSION__: string;

export class AboutView extends View {
  private container: HTMLElement;
  private platform = PlatformService.getInstance();

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--about';
    this.render();
    this.bindListeners();
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

          <h3>No Tracking or Analytics</h3>
          <p>
            NoorNote does not use any tracking services, analytics, or cookies.
            We do not collect any usage data.
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
          <h2>Version</h2>
          <p>NoorNote v${__APP_VERSION__}</p>
          ${this.platform.isTauri && !this.platform.isAndroid ? '<button class="btn btn--mini" id="about-check-update-btn">Check for updates</button>' : ''}
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
          <li><strong>No Server Storage:</strong> Our web server only hosts the static application files. We do not store any user data on the server.</li>
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

  private bindListeners(): void {
    const checkUpdateBtn = this.container.querySelector('#about-check-update-btn');
    checkUpdateBtn?.addEventListener('click', async () => {
      const { UpdateCheckService } = await import('../../services/UpdateCheckService');
      await UpdateCheckService.getInstance().checkManually(checkUpdateBtn as HTMLButtonElement);
    });
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.container.remove();
  }
}
