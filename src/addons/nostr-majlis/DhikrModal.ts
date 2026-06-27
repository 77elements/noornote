/**
 * DhikrModal - the shared create/commit/edit modal for Community Dhikr (M3).
 *
 * mode 'create': enter dhikr phrase + target count + optional description.
 * mode 'commit': the round's fields are shown read-only (locked, even for the author) and a
 *   single "your count" field is added; submitting adds to the round's pot.
 * mode 'edit' (admin moderation): the round's fields are pre-filled and editable; submitting stores
 *   them as an admin override (the original author's event is never modified).
 * Publishing goes through DhikrService → the two hardcoded dhikr relays only. Those relays are
 * write-restricted, so a note tells the user they need an account on one of them.
 */

import { ModalService } from '../../services/ModalService';
import { ToastService } from '../../services/ToastService';
import { AuthGuard } from '../../services/AuthGuard';
import { escapeHtml } from '../../helpers/escapeHtml';
import { AddonLoader } from '../AddonLoader';
import type { NostrMajlisRuntime } from './runtime';
import type { DhikrRound } from './dhikr';

const ACCOUNT_HINT =
  'You need an account on noornode.nostr1.com or bitcoinmajlis.nostr1.com to post here.';

type DhikrMode = 'create' | 'commit' | 'edit';

export class DhikrModal {
  private submitting = false;

  constructor(private mode: DhikrMode, private round?: DhikrRound) {}

  private service() {
    return AddonLoader.getInstance().getRuntime<NostrMajlisRuntime>('nostr-majlis')?.dhikr ?? null;
  }

  open(): void {
    const content = document.createElement('div');
    content.className = 'dhikr-modal';
    const hint = `<p class="setting__desc">${ACCOUNT_HINT}</p>`;

    if (this.mode === 'create' || this.mode === 'edit') {
      const r = this.round; // present in edit mode, absent in create mode
      const submitLabel = this.mode === 'edit' ? 'Save changes' : 'Create new dhikr';
      content.innerHTML = `
        <div class="form__row"><label class="setting__label" for="dk-phrase">Dhikr</label>
          <input id="dk-phrase" class="input" type="text" placeholder="e.g. Alhamdulillah" maxlength="100" value="${r ? escapeHtml(r.phrase) : ''}"></div>
        <div class="form__row"><label class="setting__label" for="dk-goal">Count</label>
          <input id="dk-goal" class="input" type="number" min="1" placeholder="e.g. 10000" value="${r ? r.goal : ''}"></div>
        <div class="form__row"><label class="setting__label" for="dk-desc">Description (optional)</label>
          <textarea id="dk-desc" class="input" rows="2" maxlength="280">${r ? escapeHtml(r.description) : ''}</textarea></div>
        ${hint}
        <div class="l-row--right"><button class="btn btn--primary" data-action="submit">${submitLabel}</button></div>
      `;
    } else {
      const r = this.round!;
      content.innerHTML = `
        <div class="form__row"><label class="setting__label">Dhikr</label>
          <input class="input" type="text" value="${escapeHtml(r.phrase)}" disabled></div>
        <div class="form__row"><label class="setting__label">Count</label>
          <input class="input" type="number" value="${r.goal}" disabled></div>
        ${r.description ? `<div class="form__row"><label class="setting__label">Description</label>
          <textarea class="input" rows="2" disabled>${escapeHtml(r.description)}</textarea></div>` : ''}
        <div class="form__row"><label class="setting__label" for="dk-amount">Your count</label>
          <input id="dk-amount" class="input" type="number" min="1" placeholder="e.g. 100"></div>
        ${hint}
        <div class="l-row--right"><button class="btn btn--primary" data-action="submit">Submit</button></div>
      `;
    }

    ModalService.getInstance().show({
      title: this.titleFor(),
      content,
    });
    content.querySelector('[data-action="submit"]')?.addEventListener('click', () => void this.submit(content));
  }

  private titleFor(): string {
    if (this.mode === 'create') return 'Create new dhikr';
    if (this.mode === 'edit') return 'Edit dhikr';
    return 'Commit to this dhikr';
  }

  private authGuardLabel(): string {
    if (this.mode === 'create') return 'create a dhikr';
    if (this.mode === 'edit') return 'edit a dhikr';
    return 'commit to a dhikr';
  }

  private async submit(content: HTMLElement): Promise<void> {
    if (this.submitting) return;
    const svc = this.service();
    if (!svc) { ToastService.show('Community Dhikr is not available', 'error'); return; }
    if (!AuthGuard.requireAuth(this.authGuardLabel())) return;

    const btn = content.querySelector('[data-action="submit"]') as HTMLButtonElement | null;
    const label = btn?.textContent ?? '';
    const setBusy = (busy: boolean) => {
      if (!btn) return;
      btn.disabled = busy;
      btn.textContent = busy ? 'Sending…' : label;
    };
    this.submitting = true;
    setBusy(true);

    try {
      if (this.mode === 'create' || this.mode === 'edit') {
        const phrase = (content.querySelector('#dk-phrase') as HTMLInputElement).value.trim();
        const goal = parseInt((content.querySelector('#dk-goal') as HTMLInputElement).value, 10);
        const description = (content.querySelector('#dk-desc') as HTMLTextAreaElement).value.trim();
        if (!phrase) { ToastService.show('Enter a dhikr', 'error'); return; }
        if (!Number.isFinite(goal) || goal <= 0) { ToastService.show('Enter a valid count', 'error'); return; }
        if (this.mode === 'edit') {
          await svc.editRound(this.round!, { phrase, goal, description });
          ToastService.show('Dhikr updated', 'success');
        } else {
          await svc.publishRound(phrase, goal, description);
          ToastService.show('Dhikr created', 'success');
        }
      } else {
        const amount = parseInt((content.querySelector('#dk-amount') as HTMLInputElement).value, 10);
        if (!Number.isFinite(amount) || amount <= 0) { ToastService.show('Enter a valid count', 'error'); return; }
        await svc.commit(this.round!, amount);
        ToastService.show('Your dhikr was submitted', 'success');
      }
      ModalService.getInstance().hide();
    } catch {
      ToastService.show('Could not publish to the dhikr relays', 'error');
    } finally {
      this.submitting = false;
      setBusy(false); // harmless if the modal already closed
    }
  }
}
