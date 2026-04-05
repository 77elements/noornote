/**
 * PollCreator Component
 * Modular poll creation interface for NIP-88 polls
 *
 * Features:
 * - Multiple poll options (min 2, dynamic add/remove)
 * - Multiple choice toggle
 * - Optional end date
 * - Optional relay URLs
 * - Clean, reusable architecture
 */

import { Switch } from '../ui/Switch';

export interface PollOption {
  id: string;
  label: string;
}

export interface PollData {
  options: PollOption[];
  multipleChoice: boolean;
  endDate?: number; // Unix timestamp
  relayUrls?: string[];
}

export interface PollCreatorConfig {
  onPollDataChange: (data: PollData | null) => void;
}

export class PollCreator {
  private config: PollCreatorConfig;
  private container: HTMLElement | null = null;
  private multipleChoiceSwitch: Switch | null = null;

  // State
  private options: PollOption[] = [
    { id: this.generateId(), label: '' },
    { id: this.generateId(), label: '' }
  ];
  private multipleChoice: boolean = false;
  private endDate: string = ''; // ISO string for datetime-local input
  private relayUrls: string = '';

  constructor(config: PollCreatorConfig) {
    this.config = config;
  }

  /**
   * Generate unique ID for poll options
   */
  private generateId(): string {
    return Math.random().toString(36).substring(2, 11);
  }

  /**
   * Render poll creator HTML
   */
  public render(): string {
    return `
      <div class="poll-creator">
        <div class="poll-creator__header">
          <span class="poll-creator__title">Poll Configuration</span>
          <button class="poll-creator__remove" data-action="remove-poll" type="button">Remove Poll</button>
        </div>

        <div class="poll-creator__options">
          ${this.options.map((option, index) => `
            <div class="poll-creator__option" data-option-id="${option.id}">
              <input
                type="text"
                class="input"
                placeholder="Option ${index + 1}"
                value="${option.label}"
                data-option-input="${option.id}"
                maxlength="100"
              />
              ${this.options.length > 2 ? `
                <button
                  class="poll-creator__option-remove"
                  data-action="remove-option"
                  data-option-id="${option.id}"
                  type="button"
                  title="Remove option"
                >×</button>
              ` : ''}
            </div>
          `).join('')}
        </div>

        <button class="btn btn--passive" data-action="add-option" type="button">
          + Add Option
        </button>

        <div class="poll-creator__settings">
          <div class="poll-creator__setting" id="poll-multiple-choice-container">
            <!-- Switch will be mounted here -->
          </div>

          <div class="poll-creator__setting">
            <label class="poll-creator__setting-label">
              End Date (optional)
            </label>
            <input
              type="datetime-local"
              class="poll-creator__datetime"
              data-input="end-date"
              value="${this.endDate}"
            />
          </div>

          <details class="poll-creator__advanced">
            <summary class="poll-creator__advanced-toggle">Advanced Options</summary>
            <div class="poll-creator__advanced-content">
              <div class="poll-creator__setting">
                <label class="poll-creator__setting-label">
                  Relay URLs (optional, comma-separated)
                  <span class="poll-creator__hint">Usually not needed - uses your default relays</span>
                </label>
                <input
                  type="text"
                  class="poll-creator__relay-input"
                  placeholder="wss://relay1.com, wss://relay2.com"
                  value="${this.relayUrls}"
                  data-input="relay-urls"
                />
              </div>
            </div>
          </details>
        </div>

        <div class="poll-creator__notice">
          <span class="poll-creator__notice-icon">⚠</span>
          <div class="poll-creator__notice-text">
            <strong>This is a poll note.</strong><br>
            Unlike regular notes, polls are not widely supported and may not display on other clients.
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Setup event listeners after rendering
   */
  public setupEventListeners(container: HTMLElement): void {
    this.container = container;

    // Multiple choice switch
    const switchContainer = container.querySelector('#poll-multiple-choice-container');
    if (switchContainer) {
      this.multipleChoiceSwitch = new Switch({
        label: 'Allow multiple choices',
        checked: this.multipleChoice,
        onChange: (checked) => {
          this.multipleChoice = checked;
          this.emitPollData();
        }
      });

      switchContainer.innerHTML = this.multipleChoiceSwitch.render();
      this.multipleChoiceSwitch.setupEventListeners(switchContainer as HTMLElement);
    }

    // Add option button
    const addOptionBtn = container.querySelector('[data-action="add-option"]');
    if (addOptionBtn) {
      addOptionBtn.addEventListener('click', () => this.handleAddOption());
    }

    // Remove option buttons
    const removeOptionBtns = container.querySelectorAll('[data-action="remove-option"]');
    removeOptionBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const optionId = target.dataset.optionId;
        if (optionId) {
          this.handleRemoveOption(optionId);
        }
      });
    });

    // Option inputs
    this.options.forEach(option => {
      const input = container.querySelector(`[data-option-input="${option.id}"]`) as HTMLInputElement;
      if (input) {
        input.addEventListener('input', () => {
          this.handleOptionChange(option.id, input.value);
        });
      }
    });

    // End date input
    const endDateInput = container.querySelector('[data-input="end-date"]') as HTMLInputElement;
    if (endDateInput) {
      endDateInput.addEventListener('change', () => {
        this.endDate = endDateInput.value;
        this.emitPollData();
      });
    }

    // Relay URLs input
    const relayUrlsInput = container.querySelector('[data-input="relay-urls"]') as HTMLInputElement;
    if (relayUrlsInput) {
      relayUrlsInput.addEventListener('input', () => {
        this.relayUrls = relayUrlsInput.value;
        this.emitPollData();
      });
    }

    // Remove poll button
    const removePollBtn = container.querySelector('[data-action="remove-poll"]');
    if (removePollBtn) {
      removePollBtn.addEventListener('click', () => this.handleRemovePoll());
    }
  }

  /**
   * Handle add option
   */
  private handleAddOption(): void {
    this.options.push({
      id: this.generateId(),
      label: ''
    });
    this.rerender();
    this.emitPollData();
  }

  /**
   * Handle remove option
   */
  private handleRemoveOption(optionId: string): void {
    if (this.options.length <= 2) return; // Minimum 2 options

    this.options = this.options.filter(opt => opt.id !== optionId);
    this.rerender();
    this.emitPollData();
  }

  /**
   * Handle option change
   */
  private handleOptionChange(optionId: string, value: string): void {
    const option = this.options.find(opt => opt.id === optionId);
    if (option) {
      option.label = value;
      this.emitPollData();
    }
  }

  /**
   * Handle remove poll
   */
  private handleRemovePoll(): void {
    this.config.onPollDataChange(null);
  }

  /**
   * Emit current poll data to parent
   */
  private emitPollData(): void {
    const pollData: PollData = {
      options: this.options,
      multipleChoice: this.multipleChoice
    };

    // Add end date if set
    if (this.endDate) {
      pollData.endDate = Math.floor(new Date(this.endDate).getTime() / 1000);
    }

    // Add relay URLs if set
    if (this.relayUrls.trim()) {
      pollData.relayUrls = this.relayUrls
        .split(',')
        .map(url => url.trim())
        .filter(url => url.length > 0);
    }

    this.config.onPollDataChange(pollData);
  }

  /**
   * Re-render component
   */
  private rerender(): void {
    if (!this.container) return;

    const parent = this.container.parentElement;
    if (!parent) return;

    // Store current state before rerender
    const html = this.render();
    this.container.innerHTML = html;

    // Re-setup event listeners
    setTimeout(() => {
      this.setupEventListeners(this.container!);
    }, 0);
  }

  /**
   * Get current poll data
   */
  public getPollData(): PollData | null {
    // Validate: at least 2 options with non-empty labels
    const validOptions = this.options.filter(opt => opt.label.trim().length > 0);
    if (validOptions.length < 2) {
      return null;
    }

    const pollData: PollData = {
      options: validOptions,
      multipleChoice: this.multipleChoice
    };

    if (this.endDate) {
      pollData.endDate = Math.floor(new Date(this.endDate).getTime() / 1000);
    }

    if (this.relayUrls.trim()) {
      pollData.relayUrls = this.relayUrls
        .split(',')
        .map(url => url.trim())
        .filter(url => url.length > 0);
    }

    return pollData;
  }

  /**
   * Cleanup resources
   */
  public destroy(): void {
    if (this.multipleChoiceSwitch) {
      this.multipleChoiceSwitch.destroy();
      this.multipleChoiceSwitch = null;
    }
    this.container = null;
  }
}
