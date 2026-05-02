/**
 * LoggedOutModals
 * Humorous modals shown when logged-out users try to interact with notes
 * Each reaction type has a unique message + CTA to create account or login
 */

import { ModalService } from '../services/ModalService';
import { Router } from '../services/Router';
import { AuthService } from '../services/AuthService';

const POST_LOGIN_REDIRECT_KEY = 'noornote_post_login_redirect';

export interface LoggedOutModalOptions {
  /** URL to navigate to after a successful login. Stored in sessionStorage
   *  and consumed by PostLoginService — works for both the in-place NIP-07
   *  flow (Alby popup) and the /login redirect fallback (Bunker, etc.). */
  postLoginAction?: string;
}

const MODAL_MESSAGES: Record<string, { icon: string; text: string }> = {
  like: {
    icon: '💜',
    text: 'You could shower this note with a thousand emojis, but you\'ll need an account first.'
  },
  zap: {
    icon: '⚡',
    text: 'Real money for real posts. Set up an account and a wallet, and you\'re in business.'
  },
  repost: {
    icon: '🔁',
    text: 'Spreading the word? Love the energy. Just need you to log in first.'
  },
  reply: {
    icon: '💬',
    text: 'Got something to say? We\'re all ears - right after you create an account.'
  },
  bookmark: {
    icon: '🔖',
    text: 'Want to save this for later? Create an account and it\'s yours forever.'
  },
  dm: {
    icon: '✉️',
    text: 'Want to drop them a private message? Encrypted, peer-to-peer — but you\'ll need a key first.'
  }
};

/**
 * Show a humorous modal for a specific reaction type when user is not logged in
 */
export function showLoggedOutReactionModal(
  reactionType: string,
  opts: LoggedOutModalOptions = {}
): void {
  const modalService = ModalService.getInstance();
  const router = Router.getInstance();
  const msg = MODAL_MESSAGES[reactionType] ?? MODAL_MESSAGES['like']!;

  const content = document.createElement('div');
  content.className = 'logged-out-modal';
  content.innerHTML = `
    <div class="logged-out-modal__icon">${msg.icon}</div>
    <p class="logged-out-modal__text">${msg.text}</p>
    <div class="logged-out-modal__actions">
      <button class="btn btn--large logged-out-modal__create">Create my account</button>
      <button class="btn btn--passive logged-out-modal__login">I already have a key</button>
    </div>
    <p class="logged-out-modal__note">Ready in 2 minutes. No email. No phone number.</p>
  `;

  // On the public NosPress page there is no MainLayout in the DOM (setupUI()
  // is skipped by App.ts's boot path), so router.navigate('/login') has no
  // mount target. We instead try an in-place NIP-07 login (Alby popup) first;
  // if that's not possible we fall back to a full page-load to /login where
  // Bunker / NoorSigner / npub-paste are also available.
  const isPublicView = document.documentElement.classList.contains('layout--public');

  const stashRedirect = (): void => {
    if (opts.postLoginAction) {
      sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, opts.postLoginAction);
    }
  };

  content.querySelector('.logged-out-modal__create')?.addEventListener('click', async () => {
    modalService.hide();
    stashRedirect();
    if (isPublicView) {
      window.location.href = '/welcome';
      return;
    }
    const { AccountSetupWizard } = await import('../components/onboarding/AccountSetupWizard');
    const wizard = new AccountSetupWizard();
    wizard.show();
  });

  content.querySelector('.logged-out-modal__login')?.addEventListener('click', async () => {
    modalService.hide();
    stashRedirect();

    // Public view: prefer in-place NIP-07 (Alby/nos2x popup, user stays on
    // the page). Fall back to /login redirect for Bunker / NoorSigner /
    // other auth methods, or when no extension is installed.
    if (isPublicView) {
      const authService = AuthService.getInstance();
      if (authService.isExtensionAvailable()) {
        try {
          const result = await authService.authenticate();
          if (result.success) {
            // user:login event fires → PostLoginService consumes the
            // redirect key; full reload triggers App.ts's logged-in branch.
            window.location.reload();
            return;
          }
        } catch {
          // fall through to /login
        }
      }
      window.location.href = '/login';
      return;
    }

    router.navigate('/login');
  });

  modalService.show({
    title: '',
    content,
    width: '420px',
  });
}
