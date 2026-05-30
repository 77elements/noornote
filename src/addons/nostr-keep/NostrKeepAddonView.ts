/**
 * NostrKeepAddonView — settings page + inline board (route `/addons/nostr-keep`).
 *
 * Toggle (emits `nostr-keep:addon-toggle`). When enabled, the Keep board is
 * rendered directly below the toggle — no separate full-screen route.
 * Backup/Restore buttons land in phase 1e.
 */

import { View } from '../../components/views/View';
import { Switch } from '../../components/ui/Switch';
import { TypedEventBus } from '../../core/TypedEventBus';
import { ToastService } from '../../services/ToastService';
import { AuthService } from '../../services/AuthService';
import { isNostrKeepEnabled, setNostrKeepEnabled } from './index';
import { NostrKeepView } from './NostrKeepView';

export class NostrKeepAddonView extends View {
  private container: HTMLElement;
  private enableSwitch: Switch | null = null;
  private board: NostrKeepView | null = null;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--addon view-content--addon-note-taking';
    this.render();
  }

  private render(): void {
    this.enableSwitch = new Switch({
      label: '',
      checked: isNostrKeepEnabled(),
      onChange: (checked) => {
        setNostrKeepEnabled(checked);
        TypedEventBus.getInstance().emit('note-taking:addon-toggle', { enabled: checked });
        ToastService.show(checked ? 'Note taking enabled' : 'Note taking disabled', 'success');
        this.renderBoard();
      },
    });

    this.container.innerHTML = `
      <h1>Note taking</h1>
      <section class="section">
        <div class="setting">
          <span class="setting__label">Enable Note taking</span>
          <div class="setting__control">${this.enableSwitch.render()}</div>
          <p class="setting__desc">Encrypted, offline-first notes. Your notes are NIP-44 self-encrypted and synced privately across your devices via Nostr relays — only ciphertext ever leaves this device.</p>
        </div>
      </section>
      <div data-addon-content="note-board"></div>
    `;
    this.enableSwitch.setupEventListeners(this.container);
    this.renderBoard();
  }

  /** Mount the board inline when enabled; tear it down when disabled. */
  private renderBoard(): void {
    const slot = this.container.querySelector('[data-addon-content="note-board"]') as HTMLElement | null;
    if (!slot) return;

    const npub = AuthService.getInstance().getCurrentUser()?.npub ?? '';
    const shouldShow = isNostrKeepEnabled() && !!npub;

    if (!shouldShow) {
      this.board?.destroy();
      this.board = null;
      slot.innerHTML = '';
      return;
    }

    if (this.board) return; // already mounted
    this.board = new NostrKeepView(npub);
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
