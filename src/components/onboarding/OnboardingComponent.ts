/**
 * Onboarding Component
 * Handles welcome screen for new users
 * "Yes, create account" → starts the AccountSetupWizard
 * "I already have a key" → navigates to /login
 */

import { Router } from '../../services/Router';
import { setupCarouselNavigation } from '../../helpers/CarouselHelper';
import { getImageViewer } from '../ui/ImageViewer';

export class OnboardingComponent {
  private router: Router;

  constructor() {
    this.router = Router.getInstance();
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
                <p class="mini" style="text-align: right; margin-top: 0;">Nostr illustration by @awayuki</p>
                <p><strong>Nostr</strong> stands for "Notes and Other Stuff Transmitted by Relays". It's a simple, open protocol that enables truly decentralized social networking.</p>
              </div>

              <div class="nn-carousel-slide" data-slide="1">
                <h3>Relays: The Network</h3>
                <p>Unlike traditional platforms, Nostr doesn't have a central server. Instead, it uses <strong>relays</strong>, independent servers that store and forward your messages.</p>
                <p>You can connect to multiple relays at once. If one goes down, your content lives on through others. No single point of failure.</p>
              </div>

              <div class="nn-carousel-slide" data-slide="2">
                <h3>Keys: Your Identity</h3>
                <p>Your identity on Nostr is a <strong>cryptographic key pair</strong>:</p>
                <ul>
                  <li><strong>Public key (npub)</strong>, your username, shareable with anyone</li>
                  <li><strong>Private key (nsec)</strong>, your password, never share this!</li>
                </ul>
                <p>You own your identity. No company can ban you or delete your account.</p>
              </div>

              <div class="nn-carousel-slide" data-slide="3">
                <h3>Why Nostr?</h3>
                <ul>
                  <li><strong>Censorship-resistant</strong>, no central authority can silence you</li>
                  <li><strong>Portable identity</strong>, take your followers anywhere</li>
                  <li><strong>Interoperable</strong>, use any client you like</li>
                  <li><strong>Simple</strong>, built on proven cryptography</li>
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

    // "Yes, create account" button → Start wizard directly
    const newToNostrBtn = primaryContent.querySelector('[data-action="new-to-nostr"]');
    if (newToNostrBtn) {
      newToNostrBtn.addEventListener('click', async () => {
        // Import and start the wizard
        const { AccountSetupWizard } = await import('./AccountSetupWizard');
        const wizard = new AccountSetupWizard();
        wizard.show();
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

    // Carousel image click to enlarge
    const carouselImage = primaryContent.querySelector('.nn-carousel-image') as HTMLImageElement;
    if (carouselImage) {
      carouselImage.style.cursor = 'pointer';
      carouselImage.addEventListener('click', () => {
        getImageViewer().open({ images: [carouselImage.src] });
      });
    }
  }

  /**
   * Redirect to wizard (for /createnewaccount route compatibility)
   */
  public showCreateAccountScreen(): void {
    // Redirect to wizard
    import('./AccountSetupWizard').then(({ AccountSetupWizard }) => {
      const wizard = new AccountSetupWizard();
      wizard.show();
    });
  }
}
