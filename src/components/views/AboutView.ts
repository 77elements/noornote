/**
 * AboutView Component
 * Imprint and Privacy Policy (German legal requirements)
 *
 * @purpose Display legal information required by German law (§5 TMG)
 * @used-by App.ts
 */

import { View } from './View';

export class AboutView extends View {
  private container: HTMLElement;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'about-view';
    this.render();
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
            Phone: +49 157 72456227
          </p>
          <p>
            VAT ID: DE358875454<br>
            Tax ID: 219/5337/3919
          </p>
        </section>

        <section class="about-section">
          <h2>Privacy Policy</h2>

          <h3>Responsible Party</h3>
          <p>[ mslm dvlpmnt ], Am Engeldorfer Berg 11, 50997 Cologne, Germany</p>

          <h3>Local Data Storage</h3>
          <p>
            NoorNote is a desktop application that stores all data locally on your device:
          </p>
          <ul>
            <li><strong>Key Storage:</strong> Your private key (nsec) is stored in your operating system's keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service).</li>
            <li><strong>Cache:</strong> Temporary data is stored in IndexedDB and localStorage in your browser.</li>
            <li><strong>Configuration Files:</strong> Settings are stored in the <code>~/.noornote/</code> directory.</li>
          </ul>
          <p>
            <strong>We have no access to this data.</strong> All data remains on your device.
          </p>

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

        <section class="about-section about-section--footer">
          <p>NoorNote - A Nostr Client for Desktop</p>
        </section>
    `;
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.container.remove();
  }
}
