/**
 * BookmarksAddonView
 *
 * View for the Bookmarks addon page (`/addons/bookmarks`):
 * addon enable toggle + "Sync gelesene Bookmarks über Relays" settings
 * (read-state sync via NIP-78 with a frequency selector — off by default).
 * See docs/todos/unread-bookmarks.md.
 */

import { View } from '../../components/views/View';
import { Switch } from '../../components/ui/Switch';
import { ToastService } from '../../services/ToastService';
import { ModalService } from '../../services/ModalService';
import { BookmarkReadStateService } from '../../services/BookmarkReadStateService';
import {
  isBookmarksEnabled,
  setBookmarksEnabled,
  isReadSyncEnabled,
  setReadSyncEnabled,
  getReadSyncFrequency,
  setReadSyncFrequency,
  type BookmarkReadSyncFrequency,
} from './index';
import { TypedEventBus } from '../../core/TypedEventBus';

const FREQUENCY_OPTIONS: Array<[BookmarkReadSyncFrequency, string]> = [
  ['rare', 'Rare (every 60 min)'],
  ['moderate', 'Moderate (every 30 min)'],
  ['frequent', 'Frequent (every 15 min)'],
  ['more-frequent', 'More Frequent (every 5 min)'],
  ['realtime', 'Every 60 seconds'],
];

const FREQUENCY_LABELS: Record<BookmarkReadSyncFrequency, string> = {
  rare: 'Rare (60 min)',
  moderate: 'Moderate (30 min)',
  frequent: 'Frequent (15 min)',
  'more-frequent': 'More Frequent (5 min)',
  realtime: 'Every 60 seconds',
};

export class BookmarksAddonView extends View {
  private container: HTMLElement;
  private enableSwitch: Switch | null = null;
  private syncSwitch: Switch | null = null;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className =
      'view-content view-content--addon view-content--addon-bookmarks';
    this.render();
  }

  private render(): void {
    const bookmarksEnabled = isBookmarksEnabled();
    const readSyncEnabled = isReadSyncEnabled();
    const frequency = getReadSyncFrequency();

    this.enableSwitch = new Switch({
      label: '',
      checked: bookmarksEnabled,
      onChange: checked => {
        setBookmarksEnabled(checked);
        TypedEventBus.getInstance().emit('bookmarks:addon-toggle', {
          enabled: checked,
        });
        ToastService.show(
          checked ? 'Bookmarks enabled' : 'Bookmarks disabled',
          'success'
        );
        // Keep the read-state sync in step with the addon lifecycle.
        const service = BookmarkReadStateService.getInstance();
        if (checked && isReadSyncEnabled()) {
          void service.start();
        } else {
          service.stop();
        }
        this.updateVisibility();
        // Mounted bookmarks views re-render: unread borders drop when the
        // feature deactivates, appear when it activates.
        TypedEventBus.getInstance().emit('bookmark:updated');
      },
    });

    this.syncSwitch = new Switch({
      label: '',
      checked: readSyncEnabled,
      onChange: checked => {
        setReadSyncEnabled(checked);
        const service = BookmarkReadStateService.getInstance();
        if (checked) {
          void service.start();
        } else {
          service.stop();
        }
        this.updateVisibility();
        // Mounted bookmarks views re-render: unread borders drop when the
        // feature deactivates, appear when it activates.
        TypedEventBus.getInstance().emit('bookmark:updated');
        ToastService.show(
          checked
            ? 'Bookmark read-state sync enabled'
            : 'Bookmark read-state sync disabled',
          'success'
        );
      },
    });

    const freqOptions = FREQUENCY_OPTIONS.map(
      ([value, label]) => `
        <label class="nn-checkbox nn-checkbox--label-left">
          <span class="setting__label">${label}</span>
          <input type="radio" name="bookmarks-read-freq" value="${value}" ${frequency === value ? 'checked' : ''} />
        </label>
      `
    ).join('');

    this.container.innerHTML = `
      <h1>Bookmarks</h1>
      <section class="section">
        <div class="setting">
          <span class="setting__label">Enable Bookmarks</span>
          <div class="setting__control">${this.enableSwitch.render()}</div>
          <p class="setting__desc">
            Save notes and links to bookmark folders with drag-and-drop organization.
          </p>
        </div>

        <div class="bookmarks-read-sync${bookmarksEnabled ? '' : ' is-hidden'}">
          <div class="setting">
            <span class="setting__label">Sync read bookmarks across relays</span>
            <div class="setting__control">${this.syncSwitch.render()}</div>
            <p class="setting__desc">
              Tracks which bookmarks you have opened and syncs the read-state
              across your devices (encrypted, only visible to you). When off,
              the sidebar shows the plain bookmark total.
            </p>
          </div>

          <div class="frequency-selector${readSyncEnabled ? '' : ' is-hidden'}">
            <p class="setting__label">Sync frequency</p>
            ${freqOptions}
            <div class="setting">
              <div class="setting__control">
                <button class="btn btn--medium" data-action="reset-read-state">Reset read state</button>
              </div>
              <p class="setting__desc">
                Marks ALL bookmarks as unread again (also on your other devices
                after their next sync).
              </p>
            </div>
          </div>
        </div>
      </section>
    `;

    this.enableSwitch.setupEventListeners(this.container);
    this.syncSwitch.setupEventListeners(this.container);

    this.container
      .querySelectorAll<HTMLInputElement>('input[name="bookmarks-read-freq"]')
      .forEach(radio => {
        radio.addEventListener('change', () => {
          const value = radio.value as BookmarkReadSyncFrequency;
          setReadSyncFrequency(value);
          ToastService.show(
            `Sync frequency: ${FREQUENCY_LABELS[value] || value}`,
            'success'
          );
        });
      });

    this.container
      .querySelector('[data-action="reset-read-state"]')
      ?.addEventListener('click', () => {
        void ModalService.getInstance()
          .confirm({
            title: 'Reset read state',
            message:
              'Mark ALL bookmarks as unread again? Your other devices will pick this up on their next sync.',
            confirmText: 'Reset',
            confirmDestructive: true,
          })
          .then(confirmed => {
            if (!confirmed) return;
            BookmarkReadStateService.getInstance()
              .reset()
              .then(() =>
                ToastService.show(
                  'Read state reset — all bookmarks unread',
                  'success'
                )
              )
              .catch(error =>
                ToastService.show(
                  `Reset failed: ${String(error)}`,
                  'error',
                  8000
                )
              );
          });
      });
  }

  /** Show/hide sync settings with the addon toggle (no reload — SPA rule). */
  private updateVisibility(): void {
    const syncBlock = this.container.querySelector('.bookmarks-read-sync');
    if (syncBlock) {
      syncBlock.classList.toggle('is-hidden', !isBookmarksEnabled());
    }
    // Frequency selector follows the sync switch, not the addon toggle.
    const freqSelector = this.container.querySelector('.frequency-selector');
    if (freqSelector) {
      freqSelector.classList.toggle('is-hidden', !isReadSyncEnabled());
    }
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.enableSwitch?.destroy();
    this.enableSwitch = null;
    this.syncSwitch?.destroy();
    this.syncSwitch = null;
    this.container.innerHTML = '';
  }
}
