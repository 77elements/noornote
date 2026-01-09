/**
 * Custom Emoji Picker Component
 * Popup-style emoji picker that overlays on top of content
 * Positions itself relative to trigger button
 */

import emojilib from 'emojilib';

export interface EmojiPickerOptions {
  /** Callback when emoji is selected */
  onSelect: (emoji: string) => void;
  /** Element to position picker relative to */
  triggerElement?: HTMLElement;
}

interface EmojiCategory {
  name: string;
  icon: string;
  emojis: string[];
}

// Emoji data organized by category
const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    name: 'Smileys & People',
    icon: '😀',
    emojis: [
      '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂',
      '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩',
      '😘', '😗', '😚', '😙', '😋', '😛', '😜', '🤪',
      '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨',
      '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥',
      '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕',
      '🤢', '🤮', '🤧', '🥵', '🥶', '😵', '🤯', '🤠',
      '🥳', '😎', '🤓', '🧐', '😕', '😟', '🙁', '☹️',
      '😮', '😯', '😲', '😳', '🥺', '😦', '😧', '😨',
      '😰', '😥', '😢', '😭', '😱', '😖', '😣', '😞',
      '😓', '😩', '😫', '🥱', '😤', '😡', '😠', '🤬',
      '👍', '👎', '👏', '🙌', '👐', '🤲', '🤝', '🙏',
      '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆',
      '🖕', '👇', '☝️', '👋', '🤚', '🖐', '✋', '🖖',
      '💪', '🦾', '🦿', '🦵', '🦶', '👂', '🦻', '👃'
    ]
  },
  {
    name: 'Animals & Nature',
    icon: '🐶',
    emojis: [
      '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼',
      '🐨', '🐯', '🦁', '🐮', '🐷', '🐽', '🐸', '🐵',
      '🙈', '🙉', '🙊', '🐒', '🐔', '🐧', '🐦', '🐤',
      '🐣', '🐥', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗',
      '🐴', '🦄', '🐝', '🐛', '🦋', '🐌', '🐞', '🐜',
      '🦟', '🦗', '🕷', '🕸', '🦂', '🐢', '🐍', '🦎',
      '🦖', '🦕', '🐙', '🦑', '🦐', '🦞', '🦀', '🐡',
      '🐠', '🐟', '🐬', '🐳', '🐋', '🦈', '🐊', '🐅',
      '🌸', '💮', '🏵', '🌹', '🥀', '🌺', '🌻', '🌼',
      '🌷', '🌱', '🌲', '🌳', '🌴', '🌵', '🌾', '🌿',
      '☘️', '🍀', '🍁', '🍂', '🍃', '🌍', '🌎', '🌏'
    ]
  },
  {
    name: 'Food & Drink',
    icon: '🍔',
    emojis: [
      '🍏', '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇',
      '🍓', '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝',
      '🍅', '🍆', '🥑', '🥦', '🥬', '🥒', '🌶', '🌽',
      '🥕', '🥔', '🍠', '🥐', '🥯', '🍞', '🥖', '🥨',
      '🧀', '🥚', '🍳', '🥞', '🥓', '🥩', '🍗', '🍖',
      '🌭', '🍔', '🍟', '🍕', '🥪', '🥙', '🌮', '🌯',
      '🥗', '🥘', '🍝', '🍜', '🍲', '🍛', '🍣', '🍱',
      '🥟', '🍤', '🍙', '🍚', '🍘', '🍥', '🥠', '🥮',
      '🍢', '🍡', '🍧', '🍨', '🍦', '🥧', '🧁', '🍰',
      '🎂', '🍮', '🍭', '🍬', '🍫', '🍿', '🍩', '🍪',
      '☕️', '🍵', '🍶', '🍾', '🍷', '🍸', '🍹', '🍺',
      '🍻', '🥂', '🥃', '🥤', '🧃', '🧉', '🧊'
    ]
  },
  {
    name: 'Activities',
    icon: '⚽️',
    emojis: [
      '⚽️', '🏀', '🏈', '⚾️', '🥎', '🎾', '🏐', '🏉',
      '🥏', '🎱', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏',
      '🥅', '⛳️', '🏹', '🎣', '🥊', '🥋', '🎽', '⛸',
      '🥌', '🛷', '🛹', '🏂', '⛷', '🏋️', '🤼', '🤸',
      '🤾', '🏌️', '🏇', '🧘', '🏊', '🤽', '🚣', '🧗',
      '🚴', '🚵', '🎪', '🎭', '🎨', '🎬', '🎤', '🎧',
      '🎼', '🎹', '🥁', '🎷', '🎺', '🎸', '🎻', '🎲',
      '🎯', '🎳', '🎮', '🎰', '🧩'
    ]
  },
  {
    name: 'Travel & Places',
    icon: '✈️',
    emojis: [
      '🚗', '🚕', '🚙', '🚌', '🚎', '🏎', '🚓', '🚑',
      '🚒', '🚐', '🚚', '🚛', '🚜', '🏍', '🛵', '🚲',
      '🛴', '🚨', '🚔', '🚍', '🚘', '🚖', '🚡', '🚠',
      '🚟', '🚃', '🚋', '🚝', '🚄', '🚅', '🚈', '🚂',
      '🚆', '🚇', '🚊', '🚉', '✈️', '🛫', '🛬', '🛩',
      '💺', '🚁', '🚟', '🚠', '🚡', '🛰', '🚀', '🛸',
      '⛵️', '🛥', '🚤', '⛴', '🛳', '🚢', '⚓️', '⛽️',
      '🚧', '🚦', '🚥', '🗿', '🗽', '🗼', '🏰', '🏯',
      '🏟', '🎡', '🎢', '🎠', '⛲️', '⛱', '🏖', '🏝',
      '🏜', '🌋', '⛰', '🏔', '🗻', '🏕', '⛺️', '🏠',
      '🏡', '🏘', '🏚', '🏗', '🏭', '🏢', '🏬', '🏣'
    ]
  },
  {
    name: 'Objects',
    icon: '💡',
    emojis: [
      '⌚️', '📱', '📲', '💻', '⌨️', '🖥', '🖨', '🖱',
      '🖲', '🕹', '🗜', '💾', '💿', '📀', '📼', '📷',
      '📸', '📹', '🎥', '📽', '🎞', '📞', '☎️', '📟',
      '📠', '📺', '📻', '🎙', '🎚', '🎛', '⏱', '⏲',
      '⏰', '🕰', '⌛️', '⏳', '📡', '🔋', '🔌', '💡',
      '🔦', '🕯', '🗑', '🛢', '💸', '💵', '💴', '💶',
      '💷', '💰', '💳', '💎', '⚖️', '🔧', '🔨', '⚒',
      '🛠', '⛏', '🔩', '⚙️', '⛓', '🔫', '💣', '🔪',
      '🗡', '⚔️', '🛡', '🚬', '⚰️', '⚱️', '🏺', '🔮',
      '📿', '💈', '⚗️', '🔭', '🔬', '🕳', '💊', '💉',
      '🩸', '🩹', '🩺', '🌡', '🚪', '🛏', '🛋', '🚽'
    ]
  },
  {
    name: 'Symbols',
    icon: '❤️',
    emojis: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍',
      '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖',
      '💘', '💝', '💟', '☮️', '✝️', '☪️', '🕉', '☸️',
      '✡️', '🔯', '🕎', '☯️', '☦️', '🛐', '⛎', '♈️',
      '♉️', '♊️', '♋️', '♌️', '♍️', '♎️', '♏️', '♐️',
      '♑️', '♒️', '♓️', '🆔', '⚛️', '🉑', '☢️', '☣️',
      '📴', '📳', '🈶', '🈚️', '🈸', '🈺', '🈷️', '✴️',
      '🆚', '💮', '🉐', '㊙️', '㊗️', '🈴', '🈵', '🈹',
      '🈲', '🅰️', '🅱️', '🆎', '🆑', '🅾️', '🆘', '❌',
      '⭕️', '🛑', '⛔️', '📛', '🚫', '💯', '💢', '♨️',
      '🚷', '🚯', '🚳', '🚱', '🔞', '📵', '🚭', '❗️',
      '❕', '❓', '❔', '‼️', '⁉️', '🔅', '🔆', '〽️',
      '⚠️', '🚸', '🔱', '⚜️', '🔰', '♻️', '✅', '🈯️',
      '💹', '❇️', '✳️', '❎', '🌐', '💠', '🔠', '🔡'
    ]
  },
  {
    name: 'Flags',
    icon: '🏴',
    emojis: [
      '🏁', '🚩', '🎌', '🏴', '🏳️', '🏳️‍🌈', '🏴‍☠️',
      '🇩🇪', '🇺🇸', '🇬🇧', '🇫🇷', '🇪🇸', '🇮🇹', '🇯🇵',
      '🇨🇳', '🇰🇷', '🇷🇺', '🇧🇷', '🇮🇳', '🇨🇦', '🇦🇺',
      '🇲🇽', '🇦🇷', '🇨🇱', '🇨🇴', '🇵🇪', '🇻🇪', '🇪🇨',
      '🇧🇴', '🇺🇾', '🇵🇾', '🇳🇱', '🇧🇪', '🇨🇭', '🇦🇹',
      '🇵🇱', '🇨🇿', '🇸🇰', '🇭🇺', '🇷🇴', '🇧🇬', '🇬🇷',
      '🇹🇷', '🇮🇱', '🇸🇦', '🇦🇪', '🇪🇬', '🇿🇦', '🇳🇬',
      '🇰🇪', '🇪🇹', '🇹🇭', '🇻🇳', '🇵🇭', '🇮🇩', '🇲🇾',
      '🇸🇬', '🇵🇰', '🇧🇩', '🇱🇰', '🇳🇵', '🇳🇿', '🇫🇯'
    ]
  }
];

export class EmojiPicker {
  private container: HTMLElement;
  private overlay: HTMLElement;
  private options: EmojiPickerOptions;
  private currentCategory: number = 0;
  private frequentlyUsed: string[] = [];
  private clickOutsideHandler: ((e: MouseEvent) => void) | null = null;

  constructor(options: EmojiPickerOptions) {
    this.options = options;
    this.loadFrequentlyUsed();
    this.overlay = this.createOverlay();
    this.container = this.createElement();
    this.overlay.appendChild(this.container);
  }

  /**
   * Load frequently used emojis from localStorage
   */
  private loadFrequentlyUsed(): void {
    try {
      const stored = localStorage.getItem('noornote_emoji_frequently_used');
      if (stored) {
        this.frequentlyUsed = JSON.parse(stored);
      }
    } catch (error) {
      console.warn('Failed to load frequently used emojis:', error);
    }
  }

  /**
   * Save emoji to frequently used
   */
  private saveToFrequentlyUsed(emoji: string): void {
    // Remove if already exists
    this.frequentlyUsed = this.frequentlyUsed.filter(e => e !== emoji);
    // Add to beginning
    this.frequentlyUsed.unshift(emoji);
    // Keep only last 24
    this.frequentlyUsed = this.frequentlyUsed.slice(0, 24);

    try {
      localStorage.setItem('noornote_emoji_frequently_used', JSON.stringify(this.frequentlyUsed));
    } catch (error) {
      console.warn('Failed to save frequently used emoji:', error);
    }
  }

  /**
   * Create emoji picker DOM element
   */
  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'emoji-picker-custom';

    // Search input
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'emoji-picker-search';
    searchInput.placeholder = 'Search emoji...';
    searchInput.addEventListener('input', (e) => this.handleSearch((e.target as HTMLInputElement).value));

    // Category tabs
    const tabs = document.createElement('div');
    tabs.className = 'tabs';

    EMOJI_CATEGORIES.forEach((category, index) => {
      const tab = document.createElement('button');
      tab.className = `tab ${index === 0 ? 'tab--active' : ''}`;
      tab.textContent = category.icon;
      tab.title = category.name;
      tab.dataset.category = String(index);
      tab.addEventListener('click', () => this.switchCategory(index));
      tabs.appendChild(tab);
    });

    // Emoji grid container
    const gridContainer = document.createElement('div');
    gridContainer.className = 'emoji-picker-grid-container';

    // Render frequently used (if any)
    if (this.frequentlyUsed.length > 0) {
      gridContainer.appendChild(this.createEmojiSection('Frequently Used', this.frequentlyUsed));
    }

    // Render first category
    const firstCategory = EMOJI_CATEGORIES[0];
    gridContainer.appendChild(this.createEmojiSection(firstCategory.name, firstCategory.emojis));

    container.appendChild(searchInput);
    container.appendChild(tabs);
    container.appendChild(gridContainer);

    return container;
  }

  /**
   * Create emoji section with title and grid
   */
  private createEmojiSection(title: string, emojis: string[]): HTMLElement {
    const section = document.createElement('div');
    section.className = 'emoji-picker-category';

    const titleEl = document.createElement('div');
    titleEl.className = 'emoji-picker-category-title';
    titleEl.textContent = title;
    section.appendChild(titleEl);

    const grid = document.createElement('div');
    grid.className = 'emoji-picker-grid';

    emojis.forEach(emoji => {
      grid.appendChild(this.createEmojiButton(emoji));
    });

    section.appendChild(grid);
    return section;
  }

  /**
   * Create emoji button
   */
  private createEmojiButton(emoji: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'emoji-picker-emoji';
    btn.textContent = emoji;
    btn.addEventListener('click', () => this.handleEmojiClick(emoji));
    return btn;
  }

  /**
   * Handle emoji click
   */
  private handleEmojiClick(emoji: string): void {
    this.saveToFrequentlyUsed(emoji);
    this.options.onSelect(emoji);
  }

  /**
   * Switch category
   */
  private switchCategory(categoryIndex: number): void {
    this.currentCategory = categoryIndex;

    // Update active tab
    const tabs = this.container.querySelectorAll('.tab');
    tabs.forEach((tab, index) => {
      tab.classList.toggle('tab--active', index === categoryIndex);
    });

    // Auto-scroll tab into view
    const activeTab = tabs[categoryIndex] as HTMLElement;
    if (activeTab) {
      activeTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }

    // Re-render grid
    const gridContainer = this.container.querySelector('.emoji-picker-grid-container');
    if (!gridContainer) return;

    gridContainer.innerHTML = '';

    // Add frequently used if on first category
    if (this.frequentlyUsed.length > 0 && categoryIndex === 0) {
      gridContainer.appendChild(this.createEmojiSection('Frequently Used', this.frequentlyUsed));
    }

    const category = EMOJI_CATEGORIES[categoryIndex];
    gridContainer.appendChild(this.createEmojiSection(category.name, category.emojis));
  }

  /**
   * Handle search using emojilib keywords
   */
  private handleSearch(query: string): void {
    const gridContainer = this.container.querySelector('.emoji-picker-grid-container');
    if (!gridContainer) return;

    if (!query.trim()) {
      // Reset to current category
      this.switchCategory(this.currentCategory);
      return;
    }

    const lowerQuery = query.toLowerCase();
    const searchResults: string[] = [];

    // Search through our emoji categories using emojilib keywords
    EMOJI_CATEGORIES.forEach(category => {
      category.emojis.forEach(emoji => {
        if (searchResults.length >= 100) return; // Limit results

        const keywords = (emojilib as Record<string, string[]>)[emoji] || [];
        const matches = keywords.some(kw => kw.includes(lowerQuery));

        if (matches) {
          searchResults.push(emoji);
        }
      });
    });

    // Render search results
    gridContainer.innerHTML = '';
    const title = searchResults.length > 0
      ? `Search results for "${query}"`
      : `No results for "${query}"`;
    gridContainer.appendChild(this.createEmojiSection(title, searchResults));
  }

  /**
   * Create overlay (backdrop)
   */
  private createOverlay(): HTMLElement {
    const overlay = document.createElement('div');
    overlay.className = 'emoji-picker-overlay';
    overlay.style.display = 'none';
    return overlay;
  }

  /**
   * Show emoji picker
   */
  public show(): void {
    // Add to DOM if not already there
    if (!this.overlay.parentElement) {
      document.body.appendChild(this.overlay);
    }

    this.overlay.style.display = 'flex';

    // Position picker relative to trigger element
    if (this.options.triggerElement) {
      this.positionPicker(this.options.triggerElement);
    }

    // Setup click-outside handler
    setTimeout(() => {
      this.clickOutsideHandler = (e: MouseEvent) => {
        if (!this.container.contains(e.target as Node)) {
          this.hide();
        }
      };
      document.addEventListener('click', this.clickOutsideHandler);
    }, 0);
  }

  /**
   * Position picker relative to trigger element
   */
  private positionPicker(trigger: HTMLElement): void {
    const rect = trigger.getBoundingClientRect();
    const pickerHeight = 450; // From CSS

    // Try to position above trigger, if not enough space, position below
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;

    if (spaceAbove >= pickerHeight || spaceAbove > spaceBelow) {
      // Position above
      this.container.style.bottom = `${window.innerHeight - rect.top + 10}px`;
      this.container.style.top = 'auto';
    } else {
      // Position below
      this.container.style.top = `${rect.bottom + 10}px`;
      this.container.style.bottom = 'auto';
    }

    // Position left edge of picker over the trigger icon
    this.container.style.left = `${rect.left}px`;
    this.container.style.right = 'auto';
  }

  /**
   * Hide emoji picker
   */
  public hide(): void {
    this.overlay.style.display = 'none';

    // Remove click-outside handler
    if (this.clickOutsideHandler) {
      document.removeEventListener('click', this.clickOutsideHandler);
      this.clickOutsideHandler = null;
    }
  }

  /**
   * Get DOM element
   */
  public getElement(): HTMLElement {
    return this.container;
  }

  /**
   * Cleanup
   */
  public destroy(): void {
    this.hide();
    this.overlay.remove();
  }
}
