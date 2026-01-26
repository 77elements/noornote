/**
 * Onboarding Component
 * Handles welcome screen and new account creation flow
 * Routes: /welcome, /createnewaccount
 */

import { Router } from '../../services/Router';
import { setupCarouselNavigation } from '../../helpers/CarouselHelper';
import {
  generateSecretKey,
  getPublicKey,
  bytesToHex,
  encodeNsec,
  encodeNpub
} from '../../services/NostrToolsAdapter';
import { ToastService } from '../../services/ToastService';
import { PlatformService } from '../../services/PlatformService';
import { ImportToNoorSignerModal } from '../modals/ImportToNoorSignerModal';
import { AuthService } from '../../services/AuthService';

// Tauri APIs for file save dialog
let tauriSave: typeof import('@tauri-apps/plugin-dialog').save | null = null;
let tauriWriteTextFile: typeof import('@tauri-apps/plugin-fs').writeTextFile | null = null;

const platform = PlatformService.getInstance();

if (platform.isTauri) {
  import('@tauri-apps/plugin-dialog').then(mod => { tauriSave = mod.save; });
  import('@tauri-apps/plugin-fs').then(mod => { tauriWriteTextFile = mod.writeTextFile; });
}

interface GeneratedKeypair {
  nsec: string;
  npub: string;
  privateKeyHex: string;
  publicKeyHex: string;
}

export class OnboardingComponent {
  private router: Router;
  private currentKeypair: GeneratedKeypair | null = null;

  constructor() {
    this.router = Router.getInstance();
  }

  /**
   * Generate a new Nostr keypair
   */
  private generateKeypair(): GeneratedKeypair {
    const secretKey = generateSecretKey();
    const privateKeyHex = bytesToHex(secretKey);
    const publicKeyHex = getPublicKey(secretKey);
    const nsec = encodeNsec(privateKeyHex);
    const npub = encodeNpub(publicKeyHex);

    return { nsec, npub, privateKeyHex, publicKeyHex };
  }

  /**
   * Show welcome screen for new users
   * Asks: "Are you new to Nostr?"
   */
  public showWelcomeScreen(): void {
    const primaryContent = document.querySelector('.primary-content');
    if (!primaryContent) return;

    primaryContent.innerHTML = `
      <div class="view-content view-content--onboarding">
        <h1>Welcome to NoorNote</h1>

        <section class="onboarding-section">
          <h2 class="onboarding-subtitle">Are you new to Nostr?</h2>

          <div class="onboarding-choices">
            <div class="onboarding-choice">
              <button class="btn btn--large" data-action="new-to-nostr">
                Yes, create an account
              </button>
              <p class="onboarding-hint">Generate a new keypair</p>
            </div>

            <div class="onboarding-choice">
              <button class="btn btn--large btn--passive" data-action="has-key">
                I already have a key
              </button>
              <p class="onboarding-hint">Sign in with existing account</p>
            </div>
          </div>
        </section>

        <section class="nostr-intro">
          <h2>What is Nostr?</h2>

          <div class="nn-carousel">
            <div class="nn-carousel-slides">
              <div class="nn-carousel-slide active" data-slide="0">
                <img src="/images/nostr-illustration.jpeg" alt="How Nostr works" class="nn-carousel-image" />
                <p><strong>Nostr</strong> stands for "Notes and Other Stuff Transmitted by Relays". It's a simple, open protocol that enables truly decentralized social networking.</p>
              </div>

              <div class="nn-carousel-slide" data-slide="1">
                <h3>Relays: The Network</h3>
                <p>Unlike traditional platforms, Nostr doesn't have a central server. Instead, it uses <strong>relays</strong> — independent servers that store and forward your messages.</p>
                <p>You can connect to multiple relays at once. If one goes down, your content lives on through others. No single point of failure.</p>
              </div>

              <div class="nn-carousel-slide" data-slide="2">
                <h3>Keys: Your Identity</h3>
                <p>Your identity on Nostr is a <strong>cryptographic key pair</strong>:</p>
                <ul>
                  <li><strong>Public key (npub)</strong> — Your username, shareable with anyone</li>
                  <li><strong>Private key (nsec)</strong> — Your password, never share this!</li>
                </ul>
                <p>You own your identity. No company can ban you or delete your account.</p>
              </div>

              <div class="nn-carousel-slide" data-slide="3">
                <h3>Why Nostr?</h3>
                <ul>
                  <li><strong>Censorship-resistant</strong> — No central authority can silence you</li>
                  <li><strong>Portable identity</strong> — Take your followers anywhere</li>
                  <li><strong>Interoperable</strong> — Use any client you like</li>
                  <li><strong>Simple</strong> — Built on proven cryptography</li>
                </ul>
              </div>
            </div>

            <div class="nn-carousel-nav">
              <button class="btn btn--mini btn--passive" data-action="prev-slide" disabled>Previous</button>
              <span class="nn-carousel-dots"></span>
              <button class="btn btn--mini" data-action="next-slide">Next</button>
            </div>
          </div>
        </section>
      </div>
    `;

    this.setupWelcomeViewListeners();
  }

  /**
   * Setup listeners for welcome view
   */
  private setupWelcomeViewListeners(): void {
    const primaryContent = document.querySelector('.primary-content');
    if (!primaryContent) return;

    // "Yes, create account" button
    const newToNostrBtn = primaryContent.querySelector('[data-action="new-to-nostr"]');
    if (newToNostrBtn) {
      newToNostrBtn.addEventListener('click', () => {
        this.router.navigate('/createnewaccount');
      });
    }

    // Carousel navigation
    const carousel = primaryContent.querySelector('.nn-carousel') as HTMLElement;
    if (carousel) {
      setupCarouselNavigation(carousel);
    }

    // "I already have a key" button
    const hasKeyBtn = primaryContent.querySelector('[data-action="has-key"]');
    if (hasKeyBtn) {
      hasKeyBtn.addEventListener('click', () => {
        localStorage.setItem('noornote_has_key', 'true');
        this.router.navigate('/login');
      });
    }
  }

  /**
   * Show create account screen (keypair generation)
   */
  public showCreateAccountScreen(): void {
    const primaryContent = document.querySelector('.primary-content');
    if (!primaryContent) return;

    // Generate initial keypair
    this.currentKeypair = this.generateKeypair();

    primaryContent.innerHTML = `
      <div class="view-content view-content--onboarding">
        <h1>Create Your Account</h1>

        <section class="create-account-section">
          <p class="onboarding-intro">
            Your Nostr identity is a cryptographic key pair. The <strong>private key (nsec)</strong>
            is your password — keep it secret and safe. The <strong>public key (npub)</strong>
            is your username — share it with anyone.
          </p>

          <div class="keypair-display">
            <div class="keypair-item keypair-item--critical">
              <label>Private Key (nsec) — Keep this secret!</label>
              <div class="keypair-input-row">
                <input type="text" class="input input--monospace" value="${this.currentKeypair.nsec}" readonly data-key="nsec" />
                <button class="btn btn--mini" data-action="copy-nsec" title="Copy to clipboard">Copy</button>
              </div>
            </div>

            <div class="keypair-item">
              <label>Public Key (npub) — Your username</label>
              <div class="keypair-input-row">
                <input type="text" class="input input--monospace" value="${this.currentKeypair.npub}" readonly data-key="npub" />
                <button class="btn btn--mini" data-action="copy-npub" title="Copy to clipboard">Copy</button>
              </div>
            </div>
          </div>

          <div class="keypair-actions">
            <button class="btn btn--passive" data-action="regenerate">
              Regenerate Keys
            </button>
            <button class="btn btn--passive" data-action="download">
              Download Backup
            </button>
          </div>

          <div class="backup-warning">
            <p><strong>There is no password recovery.</strong></p>
            <p>If you lose your private key, you lose access to your account forever.
            No one can help you recover it — not even us.</p>
          </div>

          <div class="backup-confirmation">
            <label class="checkbox-label">
              <input type="checkbox" data-action="confirm-backup" />
              <span>I have saved my private key in a secure location</span>
            </label>
          </div>

          <div class="create-account-actions">
            <button class="btn btn--large" data-action="continue" disabled>
              ${platform.isTauri ? 'Continue' : 'Continue to Login'}
            </button>
            <p class="onboarding-hint">
              ${platform.isTauri
                ? 'Your key will be securely stored with password protection.'
                : 'You\'ll need to import your key into a signer to log in.'}
            </p>
          </div>
        </section>

        <a href="#" class="back-link" data-action="back-to-welcome">← Back to Welcome</a>
      </div>
    `;

    this.setupCreateAccountListeners();
  }

  /**
   * Setup listeners for create account view
   */
  private setupCreateAccountListeners(): void {
    const primaryContent = document.querySelector('.primary-content');
    if (!primaryContent) return;

    // Copy nsec
    const copyNsecBtn = primaryContent.querySelector('[data-action="copy-nsec"]');
    if (copyNsecBtn) {
      copyNsecBtn.addEventListener('click', () => this.copyToClipboard('nsec'));
    }

    // Copy npub
    const copyNpubBtn = primaryContent.querySelector('[data-action="copy-npub"]');
    if (copyNpubBtn) {
      copyNpubBtn.addEventListener('click', () => this.copyToClipboard('npub'));
    }

    // Regenerate keys
    const regenerateBtn = primaryContent.querySelector('[data-action="regenerate"]');
    if (regenerateBtn) {
      regenerateBtn.addEventListener('click', () => this.regenerateKeys());
    }

    // Download backup
    const downloadBtn = primaryContent.querySelector('[data-action="download"]');
    if (downloadBtn) {
      downloadBtn.addEventListener('click', () => this.downloadBackup());
    }

    // Backup confirmation checkbox
    const confirmCheckbox = primaryContent.querySelector('[data-action="confirm-backup"]') as HTMLInputElement;
    const continueBtn = primaryContent.querySelector('[data-action="continue"]') as HTMLButtonElement;
    if (confirmCheckbox && continueBtn) {
      confirmCheckbox.addEventListener('change', () => {
        continueBtn.disabled = !confirmCheckbox.checked;
      });
    }

    // Continue to login
    if (continueBtn) {
      continueBtn.addEventListener('click', () => {
        this.handleContinue();
      });
    }

    // Back to welcome
    const backLink = primaryContent.querySelector('[data-action="back-to-welcome"]');
    if (backLink) {
      backLink.addEventListener('click', (e) => {
        e.preventDefault();
        this.router.navigate('/welcome');
      });
    }
  }

  /**
   * Copy key to clipboard
   */
  private async copyToClipboard(keyType: 'nsec' | 'npub'): Promise<void> {
    if (!this.currentKeypair) return;

    const value = keyType === 'nsec' ? this.currentKeypair.nsec : this.currentKeypair.npub;
    try {
      await navigator.clipboard.writeText(value);
      ToastService.show(`${keyType.toUpperCase()} copied to clipboard`, 'success');
    } catch {
      ToastService.show('Failed to copy to clipboard', 'error');
    }
  }

  /**
   * Regenerate keypair
   */
  private regenerateKeys(): void {
    this.currentKeypair = this.generateKeypair();

    const nsecInput = document.querySelector('[data-key="nsec"]') as HTMLInputElement;
    const npubInput = document.querySelector('[data-key="npub"]') as HTMLInputElement;
    const confirmCheckbox = document.querySelector('[data-action="confirm-backup"]') as HTMLInputElement;
    const continueBtn = document.querySelector('[data-action="continue"]') as HTMLButtonElement;

    if (nsecInput && this.currentKeypair) {
      nsecInput.value = this.currentKeypair.nsec;
    }
    if (npubInput && this.currentKeypair) {
      npubInput.value = this.currentKeypair.npub;
    }
    // Reset confirmation when regenerating
    if (confirmCheckbox) {
      confirmCheckbox.checked = false;
    }
    if (continueBtn) {
      continueBtn.disabled = true;
    }

    ToastService.show('New keypair generated', 'success');
  }

  /**
   * Download backup file
   */
  private async downloadBackup(): Promise<void> {
    if (!this.currentKeypair) return;

    const content = `NOSTR ACCOUNT BACKUP
====================
Generated: ${new Date().toISOString()}

PRIVATE KEY (nsec) - KEEP THIS SECRET!
${this.currentKeypair.nsec}

PUBLIC KEY (npub) - Your username
${this.currentKeypair.npub}

IMPORTANT:
- Your private key IS your account
- There is NO password recovery
- If you lose this key, you lose your account forever
- Store this file in a secure location
`;

    const defaultFileName = `nostr-backup-${this.currentKeypair.npub.slice(0, 12)}.txt`;

    try {
      if (platform.isTauri && tauriSave && tauriWriteTextFile) {
        // Tauri: Show save dialog
        const filePath = await tauriSave({
          defaultPath: defaultFileName,
          filters: [{
            name: 'Text Files',
            extensions: ['txt']
          }]
        });

        if (filePath) {
          await tauriWriteTextFile(filePath, content);
          ToastService.show('Backup saved', 'success');
        }
      } else if ('showSaveFilePicker' in window) {
        // Web: File System Access API (shows native save dialog)
        const handle = await (window as any).showSaveFilePicker({
          suggestedName: defaultFileName,
          types: [{
            description: 'Text Files',
            accept: { 'text/plain': ['.txt'] }
          }]
        });
        const writable = await handle.createWritable();
        await writable.write(content);
        await writable.close();
        ToastService.show('Backup saved', 'success');
      } else {
        // Fallback: Direct download (older browsers)
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = defaultFileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        ToastService.show('Backup saved to Downloads folder', 'success');
      }
    } catch (error) {
      console.error('Failed to save backup:', error);
      ToastService.show('Failed to save backup', 'error');
    }
  }

  /**
   * Handle "Continue" button click
   * Tauri: Show import modal for NoorSigner
   * Web: Navigate to login page
   */
  private handleContinue(): void {
    localStorage.setItem('noornote_has_key', 'true');

    // On Tauri, show the import modal for seamless NoorSigner integration
    if (platform.isTauri && this.currentKeypair) {
      const modal = new ImportToNoorSignerModal({
        nsec: this.currentKeypair.nsec,
        npub: this.currentKeypair.npub,
        onSuccess: async () => {
          // Log in the user automatically
          try {
            const authService = AuthService.getInstance();
            const authResult = await authService.authenticateWithKeySigner();
            if (authResult.success) {
              this.router.navigate('/');
            } else {
              console.error('Auto-login failed:', authResult.error);
              this.router.navigate('/login');
            }
          } catch (error) {
            console.error('Auto-login failed:', error);
            // Fall back to login page
            this.router.navigate('/login');
          }
        },
        onCancel: () => {
          // User can still go to login manually
        }
      });
      modal.show();
    } else {
      // Web: Navigate to login page
      this.router.navigate('/login');
    }
  }
}
