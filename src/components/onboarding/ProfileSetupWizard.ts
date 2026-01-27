/**
 * ProfileSetupWizard
 * Fullscreen step-by-step wizard for new accounts to set up their profile.
 * Replaces the entire app layout (no sidebar, no 3-column grid).
 * Renders directly into #app with its own fullscreen layout.
 *
 * Steps:
 * 1. Welcome - intro text
 * 2. Username (required) - random suggestions + custom input + display name
 * 3. Avatar (required) - upload or choose from default avatars
 * 4. Bio (optional) - textarea
 * 5. Done - summary + publish + go to timeline
 */

import { Router } from '../../services/Router';
import { ProfileEditorService, type ProfileMetadata } from '../../services/ProfileEditorService';
import { AuthService } from '../../services/AuthService';
import { EventBus } from '../../services/EventBus';
import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';
import { ImageUploader } from '../profile/ImageUploader';
import { ToastService } from '../../services/ToastService';
import {
  renderUsernameField,
  renderBioField
} from '../../helpers/profile-field-helpers';

interface WizardStep {
  id: string;
  title: string;
  required: boolean;
  render: () => HTMLElement;
  validate: () => boolean;
  collect: () => void;
}

// Word lists for random username generation
const ADJECTIVES = [
  'Happy', 'Bright', 'Swift', 'Calm', 'Bold',
  'Lucky', 'Warm', 'Cool', 'Wild', 'Free',
  'Noble', 'Wise', 'Kind', 'Pure', 'Keen'
];

const ANIMALS = [
  'Falcon', 'Otter', 'Panda', 'Eagle', 'Wolf',
  'Dolphin', 'Fox', 'Owl', 'Bear', 'Hawk',
  'Lynx', 'Raven', 'Heron', 'Whale', 'Deer'
];

// DiceBear avatar styles to mix for variety
const DICEBEAR_STYLES = ['adventurer', 'avataaars', 'bottts', 'fun-emoji', 'lorelei', 'micah', 'notionists', 'open-peeps', 'personas', 'pixel-art', 'shapes', 'thumbs'];

function generateAvatarUrl(seed: string, style: string): string {
  return `https://api.dicebear.com/9.x/${style}/svg?seed=${encodeURIComponent(seed)}`;
}

function generateRandomAvatars(count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const seed = `noornote-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`;
    const style = DICEBEAR_STYLES[i % DICEBEAR_STYLES.length]!;
    return generateAvatarUrl(seed, style);
  });
}

function generateRandomUsername(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${adj}${animal}`;
}

/** Enable to show a "Reset Wizard" debug button */
const DEBUG_SHOW_RESET = true;

export class ProfileSetupWizard {
  private router: Router;
  private profileEditorService: ProfileEditorService;
  private authService: AuthService;
  private eventBus: EventBus;
  private storage: PerAccountLocalStorage;

  private steps: WizardStep[] = [];
  private currentStepIndex: number = 0;
  private profileData: Partial<ProfileMetadata> = {};
  private avatarUploader: ImageUploader | null = null;
  private publishing: boolean = false;
  private avatarChoices: string[] = [];

  /** The fullscreen container we inject into #app */
  private container: HTMLElement | null = null;
  /** The original #app content (MainLayout), hidden during wizard */
  private originalAppContent: HTMLElement[] = [];

  constructor() {
    this.router = Router.getInstance();
    this.profileEditorService = ProfileEditorService.getInstance();
    this.authService = AuthService.getInstance();
    this.eventBus = EventBus.getInstance();
    this.storage = PerAccountLocalStorage.getInstance();

    this.steps = [
      this.createWelcomeStep(),
      this.createUsernameStep(),
      this.createAvatarStep(),
      this.createBioStep(),
      this.createDoneStep(),
    ];
  }

  /**
   * Show the wizard fullscreen, hiding the main app layout
   */
  public show(): void {
    const app = document.getElementById('app');
    if (!app) return;

    // Hide all existing app children (MainLayout etc.)
    this.originalAppContent = Array.from(app.children) as HTMLElement[];
    this.originalAppContent.forEach(el => el.style.display = 'none');

    // Create fullscreen wizard container
    this.container = document.createElement('div');
    this.container.className = 'wizard-fullscreen';
    app.appendChild(this.container);

    this.restoreProgress();
    this.renderCurrentStep();
  }

  /**
   * Remove wizard and restore main app layout
   */
  private destroy(): void {
    this.avatarUploader?.cleanup();
    this.avatarUploader = null;

    if (this.container) {
      this.container.remove();
      this.container = null;
    }

    // Restore original app content
    this.originalAppContent.forEach(el => el.style.display = '');
    this.originalAppContent = [];
  }

  private renderCurrentStep(): void {
    if (!this.container) return;

    // Cleanup previous avatar uploader
    this.avatarUploader?.cleanup();
    this.avatarUploader = null;

    const step = this.steps[this.currentStepIndex]!;

    // Build fullscreen layout: logo + content + nav
    this.container.innerHTML = '';

    // Logo
    const logo = document.createElement('div');
    logo.className = 'wizard-logo';
    logo.innerHTML = '<span class="nn-logo">NoorNote</span>';
    this.container.appendChild(logo);

    // Debug: reset button
    if (DEBUG_SHOW_RESET) {
      const resetBtn = document.createElement('button');
      resetBtn.className = 'btn btn--passive btn--small';
      resetBtn.textContent = 'Reset Wizard (debug)';
      resetBtn.style.position = 'fixed';
      resetBtn.style.top = '8px';
      resetBtn.style.right = '8px';
      resetBtn.style.zIndex = '1001';
      resetBtn.addEventListener('click', () => {
        this.clearProgress();
        this.storage.remove(StorageKeys.NEEDS_PROFILE_SETUP);
        ToastService.show('Wizard progress cleared', 'success');
        this.destroy();
        this.router.navigate('/');
      });
      this.container.appendChild(resetBtn);
    }

    // Inner content wrapper (max-width centered)
    const inner = document.createElement('div');
    inner.className = 'wizard-inner';

    // Progress indicator
    const progress = this.renderProgress();
    inner.appendChild(progress);

    // Step content
    const content = step.render();
    content.classList.add('wizard-step-content');
    inner.appendChild(content);

    // Navigation (not on Done step)
    if (step.id !== 'done') {
      const nav = this.renderNavigation(step);
      inner.appendChild(nav);
    }

    this.container.appendChild(inner);

    // Setup avatar uploader listeners after DOM insertion
    if (step.id === 'avatar') {
      const avatarUploader = this.avatarUploader as ImageUploader | null;
      if (avatarUploader) {
        const section = this.container.querySelector('.wizard-avatar-upload-section');
        if (section) {
          avatarUploader.setupEventListeners(section as HTMLElement);
        }
      }
    }
  }

  private renderProgress(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'wizard-progress';

    const contentSteps = this.steps.filter(s => s.id !== 'welcome' && s.id !== 'done');
    const currentContentIndex = contentSteps.findIndex(s => s.id === this.steps[this.currentStepIndex]!.id);

    el.innerHTML = contentSteps.map((step, i) => {
      const state = i < currentContentIndex ? 'completed' : i === currentContentIndex ? 'active' : 'upcoming';
      return `<div class="wizard-progress-dot wizard-progress-dot--${state}" title="${step.title}"></div>`;
    }).join('<div class="wizard-progress-line"></div>');

    return el;
  }

  private renderNavigation(step: WizardStep): HTMLElement {
    const nav = document.createElement('div');
    nav.className = 'wizard-nav';

    const isFirst = this.currentStepIndex === 0;
    const isRequired = step.required;
    const showSkip = !isRequired && step.id !== 'welcome';

    nav.innerHTML = `
      ${!isFirst ? '<button class="btn btn--large btn--passive" data-wizard-action="prev">Previous</button>' : '<div></div>'}
      <div class="wizard-nav-right">
        ${showSkip ? '<button class="btn btn--large btn--passive" data-wizard-action="skip">Skip</button>' : ''}
        <button class="btn btn--large" data-wizard-action="next"${isRequired ? ' disabled' : ''}>Next</button>
      </div>
    `;

    nav.querySelector('[data-wizard-action="prev"]')?.addEventListener('click', () => this.goToPreviousStep());
    nav.querySelector('[data-wizard-action="skip"]')?.addEventListener('click', () => this.goToNextStep());
    nav.querySelector('[data-wizard-action="next"]')?.addEventListener('click', () => {
      if (step.validate()) {
        step.collect();
        this.goToNextStep();
      }
    });

    return nav;
  }

  private goToNextStep(): void {
    const currentStep = this.steps[this.currentStepIndex]!;
    if (currentStep.id !== 'done') {
      currentStep.collect();
    }

    if (this.currentStepIndex < this.steps.length - 1) {
      this.currentStepIndex++;
      this.saveProgress();
      this.renderCurrentStep();
    }
  }

  private goToPreviousStep(): void {
    this.steps[this.currentStepIndex]!.collect();

    if (this.currentStepIndex > 0) {
      this.currentStepIndex--;
      this.saveProgress();
      this.renderCurrentStep();
    }
  }

  // ─── Persistence ──────────────────────────────────────────

  private saveProgress(): void {
    this.storage.set(StorageKeys.WIZARD_PROGRESS, {
      stepIndex: this.currentStepIndex,
      profileData: this.profileData,
      avatarChoices: this.avatarChoices,
    });
  }

  private restoreProgress(): void {
    const saved = this.storage.get<{
      stepIndex: number;
      profileData: Partial<ProfileMetadata>;
      avatarChoices: string[];
    } | null>(StorageKeys.WIZARD_PROGRESS, null);

    if (saved) {
      this.currentStepIndex = saved.stepIndex;
      this.profileData = saved.profileData;
      if (saved.avatarChoices?.length) {
        this.avatarChoices = saved.avatarChoices;
      }
    } else {
      this.currentStepIndex = 0;
      this.profileData = {};
    }
  }

  private clearProgress(): void {
    this.storage.remove(StorageKeys.WIZARD_PROGRESS);
  }

  private updateNextButtonState(enabled: boolean): void {
    const btn = document.querySelector('[data-wizard-action="next"]') as HTMLButtonElement;
    if (btn) btn.disabled = !enabled;
  }

  // ─── Step Definitions ──────────────────────────────────────

  private createWelcomeStep(): WizardStep {
    return {
      id: 'welcome',
      title: 'Welcome',
      required: false,
      render: () => {
        const el = document.createElement('div');
        el.innerHTML = `
          <h1>Set Up Your Profile</h1>
          <p class="wizard-intro">
            Let's set up your profile so people can find you on Nostr.
            This only takes a moment.
          </p>
          <p class="wizard-intro">
            Your profile information is published to Nostr relays as a
            <strong>Kind 0</strong> event. You can change it anytime in Settings.
          </p>
        `;
        return el;
      },
      validate: () => true,
      collect: () => {}
    };
  }

  private createUsernameStep(): WizardStep {
    const suggestions = Array.from({ length: 6 }, () => generateRandomUsername());

    return {
      id: 'username',
      title: 'Username',
      required: true,
      render: () => {
        const el = document.createElement('div');

        const heading = document.createElement('h2');
        heading.textContent = 'Choose a Username';
        el.appendChild(heading);

        const intro = document.createElement('p');
        intro.className = 'wizard-intro';
        intro.textContent = 'Your username is how others will find and mention you. Pick one of these or type your own.';
        el.appendChild(intro);

        // Suggestion chips
        const chipsContainer = document.createElement('div');
        chipsContainer.className = 'wizard-username-suggestions';
        suggestions.forEach(name => {
          const chip = document.createElement('button');
          chip.className = 'wizard-suggestion-chip';
          chip.textContent = name;
          chip.addEventListener('click', () => {
            const input = this.container?.querySelector('#name') as HTMLInputElement;
            if (input) {
              input.value = name;
              input.dispatchEvent(new Event('input'));
            }
            chipsContainer.querySelectorAll('.wizard-suggestion-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
          });
          chipsContainer.appendChild(chip);
        });
        el.appendChild(chipsContainer);

        // Username field
        const usernameField = renderUsernameField(this.profileData.name || '');
        el.appendChild(usernameField);

        // Listen for input to enable/disable Next
        setTimeout(() => {
          const input = this.container?.querySelector('#name') as HTMLInputElement;
          if (input) {
            input.addEventListener('input', () => {
              this.updateNextButtonState(input.value.trim().length > 0);
              chipsContainer.querySelectorAll('.wizard-suggestion-chip').forEach(c => c.classList.remove('active'));
            });
            this.updateNextButtonState(input.value.trim().length > 0);
          }
        }, 0);

        return el;
      },
      validate: () => {
        const input = this.container?.querySelector('#name') as HTMLInputElement;
        return !!input && input.value.trim().length > 0;
      },
      collect: () => {
        const nameInput = this.container?.querySelector('#name') as HTMLInputElement;
        if (nameInput) this.profileData.name = nameInput.value.trim();
      }
    };
  }

  private createAvatarStep(): WizardStep {
    return {
      id: 'avatar',
      title: 'Avatar',
      required: true,
      render: () => {
        const el = document.createElement('div');

        const heading = document.createElement('h2');
        heading.textContent = 'Add a Profile Picture';
        el.appendChild(heading);

        const intro = document.createElement('p');
        intro.className = 'wizard-intro';
        intro.textContent = 'Upload your own or choose one below.';
        el.appendChild(intro);

        // Upload section
        const uploadSection = document.createElement('div');
        uploadSection.className = 'wizard-avatar-upload-section';

        this.avatarUploader = new ImageUploader({
          ...(this.profileData.picture && { currentUrl: this.profileData.picture }),
          onUploadSuccess: (url) => {
            this.profileData.picture = url;
            this.updateNextButtonState(true);
            this.container?.querySelectorAll('.wizard-default-avatar').forEach(a => a.classList.remove('active'));
          },
          mediaType: 'avatar',
          className: 'wizard-avatar-uploader'
        });

        uploadSection.innerHTML = this.avatarUploader.render();
        el.appendChild(uploadSection);

        const divider = document.createElement('div');
        divider.className = 'auth-divider';
        divider.innerHTML = '<span>or choose one</span>';
        el.appendChild(divider);

        // DiceBear avatar grid
        if (this.avatarChoices.length === 0) {
          this.avatarChoices = generateRandomAvatars(12);
        }

        const grid = document.createElement('div');
        grid.className = 'wizard-avatar-grid';
        this.renderAvatarGrid(grid);
        el.appendChild(grid);

        // Regenerate button
        const regenBtn = document.createElement('button');
        regenBtn.className = 'btn btn--passive wizard-avatar-regenerate';
        regenBtn.textContent = 'Show different avatars';
        regenBtn.addEventListener('click', () => {
          this.avatarChoices = generateRandomAvatars(12);
          this.renderAvatarGrid(grid);
        });
        el.appendChild(regenBtn);

        setTimeout(() => {
          this.updateNextButtonState(!!this.profileData.picture);
        }, 0);

        return el;
      },
      validate: () => !!this.profileData.picture,
      collect: () => {}
    };
  }

  private renderAvatarGrid(grid: HTMLElement): void {
    grid.innerHTML = '';
    this.avatarChoices.forEach(url => {
      const avatarBtn = document.createElement('button');
      avatarBtn.className = 'wizard-default-avatar';
      if (this.profileData.picture === url) avatarBtn.classList.add('active');
      avatarBtn.innerHTML = `<img src="${url}" alt="Avatar" />`;
      avatarBtn.addEventListener('click', () => {
        this.profileData.picture = url;
        this.updateNextButtonState(true);
        grid.querySelectorAll('.wizard-default-avatar').forEach(a => a.classList.remove('active'));
        avatarBtn.classList.add('active');
        // Update uploader preview
        const preview = this.container?.querySelector('.wizard-avatar-upload-section [data-preview]') as HTMLElement;
        if (preview) preview.style.backgroundImage = `url('${url}')`;
      });
      grid.appendChild(avatarBtn);
    });
  }

  private createBioStep(): WizardStep {
    return {
      id: 'bio',
      title: 'Bio',
      required: false,
      render: () => {
        const el = document.createElement('div');

        const heading = document.createElement('h2');
        heading.textContent = 'Tell Us About Yourself';
        el.appendChild(heading);

        const intro = document.createElement('p');
        intro.className = 'wizard-intro';
        intro.textContent = 'A short bio helps others get to know you. You can always change this later.';
        el.appendChild(intro);

        const bioField = renderBioField(this.profileData.about || '');
        el.appendChild(bioField);

        return el;
      },
      validate: () => true,
      collect: () => {
        const textarea = this.container?.querySelector('#about') as HTMLTextAreaElement;
        if (textarea) this.profileData.about = textarea.value.trim();
      }
    };
  }

  private createDoneStep(): WizardStep {
    return {
      id: 'done',
      title: 'Done',
      required: false,
      render: () => {
        const el = document.createElement('div');
        el.className = 'wizard-done';

        el.innerHTML = `
          <h1>You're All Set!</h1>
          <div class="wizard-done-preview">
            <div class="wizard-done-avatar" style="background-image: url('${this.profileData.picture || ''}')"></div>
            <h3>${this.escapeHtml(this.profileData.name || '')}</h3>
            <p class="wizard-done-username">@${this.escapeHtml(this.profileData.name || '')}</p>
            ${this.profileData.about ? `<p class="wizard-done-bio">${this.escapeHtml(this.profileData.about)}</p>` : ''}
          </div>
          <div class="wizard-nav" style="border-top: none;">
            <button class="btn btn--large btn--passive" data-wizard-action="prev">Previous</button>
            <button class="btn btn--large" data-wizard-action="finish"${this.publishing ? ' disabled' : ''}>
              <span data-finish-text>Save & Go to Timeline</span>
              <span data-finish-spinner style="display: none;">Publishing...</span>
            </button>
          </div>
        `;

        el.querySelector('[data-wizard-action="prev"]')?.addEventListener('click', () => this.goToPreviousStep());
        el.querySelector('[data-wizard-action="finish"]')?.addEventListener('click', () => this.handleFinish());

        return el;
      },
      validate: () => true,
      collect: () => {}
    };
  }

  // ─── Publish & Finish ──────────────────────────────────────

  private async handleFinish(): Promise<void> {
    if (this.publishing) return;
    this.publishing = true;

    const finishBtn = this.container?.querySelector('[data-wizard-action="finish"]') as HTMLButtonElement;
    const finishText = this.container?.querySelector('[data-finish-text]') as HTMLElement;
    const finishSpinner = this.container?.querySelector('[data-finish-spinner]') as HTMLElement;

    if (finishBtn) finishBtn.disabled = true;
    if (finishText) finishText.style.display = 'none';
    if (finishSpinner) finishSpinner.style.display = 'inline';

    try {
      const result = await this.profileEditorService.updateProfile(this.profileData);

      if (result) {
        this.eventBus.emit('profile:updated', {
          pubkey: this.authService.getCurrentUser()?.pubkey
        });

        this.storage.remove(StorageKeys.NEEDS_PROFILE_SETUP);
        this.clearProgress();

        ToastService.show('Profile published!', 'success');

        // Destroy wizard, restore app layout, navigate to timeline
        this.destroy();
        this.router.navigate('/');
      } else {
        this.resetFinishButton(finishBtn, finishText, finishSpinner);
      }
    } catch {
      ToastService.show('Failed to publish profile', 'error');
      this.resetFinishButton(finishBtn, finishText, finishSpinner);
    }
  }

  private resetFinishButton(
    btn: HTMLButtonElement | null,
    text: HTMLElement | null,
    spinner: HTMLElement | null
  ): void {
    this.publishing = false;
    if (btn) btn.disabled = false;
    if (text) text.style.display = 'inline';
    if (spinner) spinner.style.display = 'none';
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
