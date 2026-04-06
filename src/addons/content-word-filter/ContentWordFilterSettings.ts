/**
 * ContentWordFilterSettings
 * Settings UI for the content word filter addon.
 * Renders a Switch (enable/disable) + word management (input + list).
 *
 * @used-by AddonsView (mounted in settings zone + content zone)
 */

import { SettingsSection } from '../../components/settings/SettingsSection';
import { Switch } from '../../components/ui/Switch';
import { ToastService } from '../../services/ToastService';
import { EventBus } from '../../services/EventBus';
import {
  isContentWordFilterEnabled,
  setContentWordFilterEnabled,
  getFilterWords,
  setFilterWords,
} from './index';

export class ContentWordFilterSettings extends SettingsSection {
  private enableSwitch: Switch | null = null;

  constructor() {
    super('content-word-filter-settings');
  }

  public mount(parentContainer: HTMLElement): void {
    const contentContainer = this.getContentContainer(parentContainer);
    if (!contentContainer) return;

    const enabled = isContentWordFilterEnabled();

    this.enableSwitch = new Switch({
      label: '',
      checked: enabled,
      onChange: (checked) => {
        setContentWordFilterEnabled(checked);
        EventBus.getInstance().emit('content-word-filter:toggle', { enabled: checked });
        ToastService.show(
          checked ? 'Content Word Filter enabled' : 'Content Word Filter disabled',
          'success'
        );
      },
    });

    const switchWrapper = document.createElement('div');
    switchWrapper.innerHTML = `
      <div class="setting">
        <span class="setting__label">Enable Word Filter</span>
        <div class="setting__control">${this.enableSwitch.render()}</div>
        <p class="setting__desc">Hide notes containing specific words from all timelines. Manage your blocked words below.</p>
      </div>
    `;
    contentContainer.appendChild(switchWrapper);
    this.enableSwitch.setupEventListeners(switchWrapper);
  }

  public unmount(): void {
    this.enableSwitch = null;
  }
}

/**
 * Mount the word management UI into the content zone of AddonsView.
 * Renders an input + add button, and a list of current filter words with remove buttons.
 */
export function mountWordFilterContent(contentEl: HTMLElement): void {
  renderWordList(contentEl);
  bindInputHandler(contentEl);
}

function renderWordList(contentEl: HTMLElement): void {
  const words = getFilterWords();

  contentEl.innerHTML = `
    <div class="form__row form__row--oneline" style="margin-bottom: calc(var(--gap, 1rem) / 2)">
      <input type="text" class="input" placeholder="Enter word to filter" data-action="word-input" />
      <button class="btn btn--medium" data-action="add-word">Add</button>
    </div>
    ${words.length > 0 ? `
      <div class="ui-list">
        ${words.map(word => `
          <div class="ui-list__item" style="display: flex; justify-content: space-between; align-items: center;">
            <span>${escapeHtml(word)}</span>
            <button class="btn btn--mini btn--danger" data-action="remove-word" data-word="${escapeAttr(word)}">Remove</button>
          </div>
        `).join('')}
      </div>
    ` : '<p class="muted">No filter words yet.</p>'}
  `;

  // Bind remove handlers
  contentEl.querySelectorAll('[data-action="remove-word"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const word = (btn as HTMLElement).dataset.word;
      if (!word) return;
      const updated = getFilterWords().filter(w => w !== word);
      setFilterWords(updated);
      ToastService.show(`Removed "${word}" from filter`, 'success');
      renderWordList(contentEl);
      bindInputHandler(contentEl);
    });
  });
}

function bindInputHandler(contentEl: HTMLElement): void {
  const input = contentEl.querySelector('[data-action="word-input"]') as HTMLInputElement;
  const addBtn = contentEl.querySelector('[data-action="add-word"]');
  if (!input || !addBtn) return;

  const addWord = () => {
    const word = input.value.trim().toLowerCase();
    if (!word) return;

    const current = getFilterWords();
    if (current.includes(word)) {
      ToastService.show(`"${word}" is already in the filter list`, 'warning');
      input.value = '';
      return;
    }

    setFilterWords([...current, word]);
    input.value = '';
    ToastService.show(`Added "${word}" to filter`, 'success');
    renderWordList(contentEl);
    bindInputHandler(contentEl);
  };

  addBtn.addEventListener('click', addWord);
  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addWord();
  });
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str: string): string {
  return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
