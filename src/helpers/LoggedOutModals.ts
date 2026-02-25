/**
 * LoggedOutModals
 * Humorous modals shown when logged-out users try to interact with notes
 * Each reaction type has a unique message + CTA to create account or login
 */

import { ModalService } from '../services/ModalService';
import { Router } from '../services/Router';

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
  }
};

/**
 * Show a humorous modal for a specific reaction type when user is not logged in
 */
export function showLoggedOutReactionModal(reactionType: string): void {
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

  content.querySelector('.logged-out-modal__create')?.addEventListener('click', async () => {
    modalService.hide();
    const { AccountSetupWizard } = await import('../components/onboarding/AccountSetupWizard');
    const wizard = new AccountSetupWizard();
    wizard.show();
  });

  content.querySelector('.logged-out-modal__login')?.addEventListener('click', () => {
    modalService.hide();
    router.navigate('/login');
  });

  modalService.show({
    title: '',
    content,
    width: '420px',
  });
}
