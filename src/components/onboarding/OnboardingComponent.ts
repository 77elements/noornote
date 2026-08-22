/**
 * Onboarding Component
 * Handles the /welcome landing page:
 * - PCC: Hero section (benefits) + Public read-only timeline
 * - SCC: Onboarding carousel ("What is Nostr?") + CTA buttons
 */

import { Router } from '../../services/Router';
import { setupCarouselNavigation } from '../../helpers/CarouselHelper';
import { getImageViewer } from '../ui/ImageViewer';
import { PublicTimelineComponent } from './PublicTimelineComponent';

export class OnboardingComponent {
  private router: Router;
  private publicTimeline: PublicTimelineComponent | null = null;

  constructor() {
    this.router = Router.getInstance();
  }

  /**
   * Show the marketing landing page (Hero + Public Timeline)
   * Renders into PCC (.primary-content)
   */
  public showWelcomeScreen(): void {
    const primaryContent = document.querySelector('.primary-content');
    if (!primaryContent) return;

    // Cleanup previous timeline if any
    this.destroyTimeline();

    primaryContent.innerHTML = `
      <div class="view-content view-content--onboarding">
        <!-- HERO SECTION (Banner 02 - Benefits) -->
        <section class="welcome-hero">
          <h1 class="welcome-hero__headline">Your voice.<br><em>Unstoppable.</em></h1>
          <p class="welcome-hero__tagline">NoorNote is social media built on open protocol - no company controls it.</p>

          <div class="welcome-hero__benefits">
            <div class="welcome-hero__benefit">
              <div class="welcome-hero__benefit-icon">🛡️</div>
              <div class="welcome-hero__benefit-title">Can't be censored</div>
              <span class="welcome-hero__badge">structurally impossible</span>
              <div class="welcome-hero__benefit-desc">Your posts live on decentralized relays. No single entity can remove them.</div>
            </div>
            <div class="welcome-hero__benefit">
              <div class="welcome-hero__benefit-icon">🔑</div>
              <div class="welcome-hero__benefit-title">Can't be deleted</div>
              <span class="welcome-hero__badge">you hold the keys</span>
              <div class="welcome-hero__benefit-desc">Your account is a cryptographic key. Nobody can suspend, ban, or take it away.</div>
            </div>
            <div class="welcome-hero__benefit">
              <div class="welcome-hero__benefit-icon">⚡</div>
              <div class="welcome-hero__benefit-title">Earn with every post</div>
              <span class="welcome-hero__badge">instant, no middleman</span>
              <div class="welcome-hero__benefit-desc">Receive Bitcoin tips (Zaps) directly. No platform cut, no payout threshold.</div>
            </div>
          </div>

          <div class="welcome-hero__cta">
            <button class="btn btn--large" data-action="new-to-nostr">Create my account</button>
            <button class="btn btn--large btn--passive" data-action="has-key">I already have a key</button>
          </div>
          <p class="welcome-hero__note">Ready in 2 minutes. No email. No phone number.</p>
        </section>

        <!-- PUBLIC TIMELINE -->
        <section class="public-timeline">
          <div class="public-timeline__header">
            <h2>See what's happening on Nostr</h2>
            <div class="public-timeline__refresh-slot"></div>
          </div>
          <div class="public-timeline__container"></div>
        </section>
      </div>
    `;

    // Initialize public timeline
    const timelineContainer = primaryContent.querySelector(
      '.public-timeline__container'
    ) as HTMLElement;
    if (timelineContainer) {
      this.publicTimeline = new PublicTimelineComponent(timelineContainer);
    }

    this.setupWelcomeViewListeners();
    this.setupSCCOnboarding();
  }

  /**
   * Setup listeners for welcome view CTA buttons
   */
  private setupWelcomeViewListeners(): void {
    const primaryContent = document.querySelector('.primary-content');
    if (!primaryContent) return;

    // "Create my account" button → Start wizard directly
    const newToNostrBtn = primaryContent.querySelector(
      '[data-action="new-to-nostr"]'
    );
    if (newToNostrBtn) {
      newToNostrBtn.addEventListener('click', async () => {
        const { AccountSetupWizard } = await import('./AccountSetupWizard');
        const wizard = new AccountSetupWizard();
        wizard.show();
      });
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
   * Setup the SCC (Secondary Content Column) with onboarding carousel
   * Replaces the system logs tab content on /welcome
   */
  private setupSCCOnboarding(): void {
    const sccBody = document.querySelector('.secondary-content-body');
    const sccTabs = document.querySelector('#sidebar-tabs');
    if (!sccBody || !sccTabs) return;

    // Save original SCC content for restoration
    const systemLogTab = sccTabs.querySelector(
      '[data-tab="system-log"]'
    ) as HTMLElement;
    if (systemLogTab) {
      systemLogTab.style.display = 'none';
    }

    // Create the onboarding tab
    const onboardingTab = document.createElement('button');
    onboardingTab.className = 'tab tab--active';
    onboardingTab.dataset.tab = 'welcome-onboarding';
    onboardingTab.textContent = 'Get Started';
    sccTabs.prepend(onboardingTab);

    // Deactivate system-log tab
    const systemLogContent = sccBody.querySelector(
      '[data-tab-content="system-log"]'
    ) as HTMLElement;
    if (systemLogContent) {
      systemLogContent.classList.remove('tab-content--active');
    }

    // Create onboarding content
    const onboardingContent = document.createElement('div');
    onboardingContent.className =
      'tab-content tab-content--active scc-onboarding';
    onboardingContent.dataset.tabContent = 'welcome-onboarding';
    onboardingContent.innerHTML = `
      <h3 class="scc-onboarding__title">What is Nostr?</h3>
      <div class="scc-onboarding__carousel">
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
      </div>
    `;

    sccBody.prepend(onboardingContent);

    // Setup carousel navigation
    const carousel = onboardingContent.querySelector(
      '.nn-carousel'
    ) as HTMLElement;
    if (carousel) {
      setupCarouselNavigation(carousel);
    }

    // Carousel image click to enlarge
    const carouselImage = onboardingContent.querySelector(
      '.nn-carousel-image'
    ) as HTMLImageElement;
    if (carouselImage) {
      carouselImage.style.cursor = 'pointer';
      carouselImage.addEventListener('click', () => {
        getImageViewer().open({ images: [carouselImage.src] });
      });
    }
  }

  /**
   * Restore the SCC to its default state (system logs)
   * Called when navigating away from /welcome
   */
  public restoreSCC(): void {
    const sccBody = document.querySelector('.secondary-content-body');
    const sccTabs = document.querySelector('#sidebar-tabs');
    if (!sccBody || !sccTabs) return;

    // Remove onboarding tab
    const onboardingTab = sccTabs.querySelector(
      '[data-tab="welcome-onboarding"]'
    );
    if (onboardingTab) {
      onboardingTab.remove();
    }

    // Remove onboarding content
    const onboardingContent = sccBody.querySelector(
      '[data-tab-content="welcome-onboarding"]'
    );
    if (onboardingContent) {
      onboardingContent.remove();
    }

    // Restore system log tab visibility and active state
    const systemLogTab = sccTabs.querySelector(
      '[data-tab="system-log"]'
    ) as HTMLElement;
    if (systemLogTab) {
      systemLogTab.style.display = '';
      systemLogTab.classList.add('tab--active');
    }

    const systemLogContent = sccBody.querySelector(
      '[data-tab-content="system-log"]'
    ) as HTMLElement;
    if (systemLogContent) {
      systemLogContent.classList.add('tab-content--active');
    }
  }

  /**
   * Cleanup the public timeline
   */
  public destroyTimeline(): void {
    if (this.publicTimeline) {
      this.publicTimeline.destroy();
      this.publicTimeline = null;
    }
  }

  /**
   * Redirect to wizard (for /createnewaccount route compatibility)
   */
  public showCreateAccountScreen(): void {
    import('./AccountSetupWizard').then(({ AccountSetupWizard }) => {
      const wizard = new AccountSetupWizard();
      wizard.show();
    });
  }
}
