/**
 * NoteTakingAddonView - settings page + inline board (route `/note-taking`).
 *
 * v1: Toggle (emits `note-taking:addon-toggle`); when enabled, the
 * note-taking board is rendered directly below the toggle.
 * v2 Focus UI: on-demand object — the object's presence IS the
 * activation (no enable switch; the addon loads on enter and releases
 * on leave, see v2OnDemand). Always-on while a note's reminder still
 * lies in the future (isNoteTakingAutoLoaded — the reminder scheduler
 * must keep running to fire it).
 */

import { View } from '../../components/views/View';
import { Switch } from '../../components/ui/Switch';
import { TypedEventBus } from '../../core/TypedEventBus';
import { ToastService } from '../../services/ToastService';
import { AuthService } from '../../services/AuthService';
import { AddonLoader } from '../AddonLoader';
import {
  isNoteTakingAutoLoaded,
  isNoteTakingEnabled,
  setNoteTakingEnabled,
} from './index';
import { isFocusUiEnabled } from '../../helpers/focusUiSetting';
import { NoteTakingView } from './NoteTakingView';
import { _ } from '../../i18n';

export class NoteTakingAddonView extends View {
  private container: HTMLElement;
  private enableSwitch: Switch | null = null;
  private board: NoteTakingView | null = null;
  /**
   * v2 on-demand object lifecycle (see CustomEmojisView.v2OnDemand): the
   * addon loads when the object is entered and unloads when it is left —
   * unless a note's reminder still lies in the future (the scheduler's
   * always-on reason, isNoteTakingAutoLoaded).
   */
  private readonly v2OnDemand = isFocusUiEnabled();

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className =
      'view-content view-content--addon view-content--addon-note-taking';
    // v2 on-demand: the object loads the addon regardless of the stored
    // preference — the board renders either way. Released in destroy().
    if (this.v2OnDemand) {
      void AddonLoader.getInstance().ensureLoaded('note-taking');
    }
    this.render();
  }

  private render(): void {
    if (!this.v2OnDemand) {
      this.enableSwitch = new Switch({
        label: '',
        checked: isNoteTakingEnabled(),
        onChange: checked => {
          setNoteTakingEnabled(checked);
          TypedEventBus.getInstance().emit('note-taking:addon-toggle', {
            enabled: checked,
          });
          ToastService.show(
            checked
              ? _('%s enabled', _('Note taking'))
              : _('%s disabled', _('Note taking')),
            'success'
          );
          this.renderBoard();
        },
      });
    }

    this.container.innerHTML = `
      <div class="back-padder focus-flow-root">
        <h1>${_('Note taking')}</h1>
        ${
          this.v2OnDemand
            ? ''
            : `<section class="section">
          <div class="setting">
            <span class="setting__label">${_('Enable Note taking')}</span>
            <div class="setting__control">${this.enableSwitch?.render() ?? ''}</div>
            <p class="setting__desc">${_('Encrypted, offline-first notes. Your notes are NIP-44 self-encrypted and synced privately across your devices via Nostr relays, so only ciphertext ever leaves this device.')}</p>
          </div>
        </section>`
        }
        <div data-addon-content="note-board"></div>
      </div>
    `;
    this.enableSwitch?.setupEventListeners(this.container);
    this.renderBoard();
  }

  /** Mount the board inline when enabled; tear it down when disabled. */
  private renderBoard(): void {
    const slot = this.container.querySelector(
      '[data-addon-content="note-board"]'
    ) as HTMLElement | null;
    if (!slot) return;

    const npub = AuthService.getInstance().getCurrentUser()?.npub ?? '';
    // v2 on-demand: the object shows the board regardless of the stored
    // preference (the object's presence is the activation).
    const shouldShow = (isNoteTakingEnabled() || this.v2OnDemand) && !!npub;

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
    // v2 on-demand release: unload after the object is left — unless a
    // note's reminder still lies in the future (the scheduler's always-on
    // reason, isNoteTakingAutoLoaded).
    if (this.v2OnDemand && !isNoteTakingAutoLoaded()) {
      void AddonLoader.getInstance().deactivateOnDemand('note-taking');
    }
  }
}
