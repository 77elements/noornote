/**
 * NoteTakingAddonView - settings page + inline board (route `/addons/note-taking`).
 *
 * Toggle (emits `note-taking:addon-toggle`). When enabled, the note-taking board is
 * rendered directly below the toggle - no separate full-screen route.
 * Backup/Restore buttons land in phase 1e.
 */

import { View } from '../../components/views/View';
import { Switch } from '../../components/ui/Switch';
import { TypedEventBus } from '../../core/TypedEventBus';
import { ToastService } from '../../services/ToastService';
import { AuthService } from '../../services/AuthService';
import { isNoteTakingEnabled, setNoteTakingEnabled } from './index';
import { NoteTakingView } from './NoteTakingView';

export class NoteTakingAddonView extends View {
  private container: HTMLElement;
  private enableSwitch: Switch | null = null;
  private board: NoteTakingView | null = null;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className =
      'view-content view-content--addon view-content--addon-note-taking';
    this.render();
  }

  private render(): void {
    this.enableSwitch = new Switch({
      label: '',
      checked: isNoteTakingEnabled(),
      onChange: checked => {
        setNoteTakingEnabled(checked);
        TypedEventBus.getInstance().emit('note-taking:addon-toggle', {
          enabled: checked,
        });
        ToastService.show(
          checked ? 'Note taking enabled' : 'Note taking disabled',
          'success'
        );
        this.renderBoard();
      },
    });

    this.container.innerHTML = `
      <h1>Note taking</h1>
      <section class="section">
        <div class="setting">
          <span class="setting__label">Enable Note taking</span>
          <div class="setting__control">${this.enableSwitch.render()}</div>
          <p class="setting__desc">Encrypted, offline-first notes. Your notes are NIP-44 self-encrypted and synced privately across your devices via Nostr relays, so only ciphertext ever leaves this device.</p>
        </div>
      </section>
      <div data-addon-content="note-board"></div>
    `;
    this.enableSwitch.setupEventListeners(this.container);
    this.renderBoard();
  }

  /** Mount the board inline when enabled; tear it down when disabled. */
  private renderBoard(): void {
    const slot = this.container.querySelector(
      '[data-addon-content="note-board"]'
    ) as HTMLElement | null;
    if (!slot) return;

    const npub = AuthService.getInstance().getCurrentUser()?.npub ?? '';
    const shouldShow = isNoteTakingEnabled() && !!npub;

    if (!shouldShow) {
      this.board?.destroy();
      this.board = null;
      slot.innerHTML = '';
      return;
    }

    if (this.board) return; // already mounted
    this.board = new NoteTakingView(npub);
    slot.appendChild(this.board.getElement());
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.board?.destroy();
    this.board = null;
    this.enableSwitch?.destroy();
    this.enableSwitch = null;
    this.container.innerHTML = '';
  }
}
