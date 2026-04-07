/**
 * Custom Emoji Picker Component
 * Popup-style emoji picker that overlays on top of content
 * Uses emojilib for full emoji support (~1900 emojis)
 */

import emojilibData from 'emojilib';
import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';

// Handle both default and named export patterns
const emojilib: Record<string, string[]> = (emojilibData as any).default || emojilibData;

export interface CustomEmojiEntry {
  shortcode: string;
  url: string;
}

export interface EmojiPickerOptions {
  /** Callback when emoji is selected */
  onSelect: (emoji: string) => void;
  /** Element to position picker relative to */
  triggerElement?: HTMLElement;
  /** Optional NIP-30 custom emojis (rendered as a section at the top) */
  customEmojis?: CustomEmojiEntry[];
  /** Callback when a custom emoji is selected (instead of onSelect) */
  onCustomSelect?: (entry: CustomEmojiEntry) => void;
}

interface EmojiCategory {
  name: string;
  icon: string;
  keywords: string[]; // Keywords to match emojis to this category
}

// Category definitions with keywords for matching
const CATEGORY_DEFINITIONS: EmojiCategory[] = [
  {
    name: 'Smileys & People',
    icon: '😀',
    keywords: ['face', 'smile', 'happy', 'sad', 'angry', 'person', 'hand', 'gesture', 'body', 'emotion', 'people', 'human', 'man', 'woman', 'boy', 'girl', 'baby', 'family']
  },
  {
    name: 'Animals & Nature',
    icon: '🐶',
    keywords: ['animal', 'nature', 'plant', 'flower', 'tree', 'dog', 'cat', 'bird', 'fish', 'bug', 'insect', 'mammal', 'wildlife', 'pet', 'leaf', 'weather', 'sun', 'moon', 'star', 'ocean', 'earth', 'world']
  },
  {
    name: 'Food & Drink',
    icon: '🍔',
    keywords: ['food', 'drink', 'fruit', 'vegetable', 'meal', 'dessert', 'sweet', 'meat', 'bread', 'rice', 'wine', 'beer', 'coffee', 'tea', 'restaurant', 'eat', 'hungry']
  },
  {
    name: 'Activities',
    icon: '⚽️',
    keywords: ['sport', 'game', 'activity', 'ball', 'medal', 'trophy', 'music', 'art', 'entertainment', 'hobby', 'play', 'win', 'team']
  },
  {
    name: 'Travel & Places',
    icon: '✈️',
    keywords: ['travel', 'place', 'vehicle', 'car', 'train', 'plane', 'boat', 'building', 'house', 'city', 'country', 'map', 'transport', 'vacation', 'trip', 'hotel']
  },
  {
    name: 'Objects',
    icon: '💡',
    keywords: ['object', 'tool', 'device', 'phone', 'computer', 'office', 'money', 'mail', 'book', 'pen', 'clothing', 'bag', 'glasses', 'watch', 'key', 'lock', 'light', 'electric']
  },
  {
    name: 'Symbols',
    icon: '❤️',
    keywords: ['symbol', 'heart', 'love', 'arrow', 'sign', 'warning', 'number', 'letter', 'word', 'math', 'zodiac', 'religion', 'peace', 'recycle', 'check', 'cross', 'button']
  },
  {
    name: 'Flags',
    icon: '🏴',
    keywords: ['flag', 'country', 'nation', 'banner']
  }
];

// Cache for categorized emojis
let categorizedEmojis: Map<string, string[]> | null = null;
let allEmojis: Array<{ emoji: string; keywords: string[] }> | null = null;

/**
 * Initialize emoji data from emojilib
 */
function initializeEmojiData(): void {
  if (categorizedEmojis && allEmojis) return;

  categorizedEmojis = new Map();
  allEmojis = [];

  // Initialize empty arrays for each category
  CATEGORY_DEFINITIONS.forEach(cat => {
    categorizedEmojis!.set(cat.name, []);
  });
  categorizedEmojis.set('Other', []);

  // Process all emojis from emojilib
  const emojiEntries = Object.entries(emojilib);

  for (const [emoji, keywords] of emojiEntries) {
    // Skip empty or invalid entries
    if (!emoji || !keywords || keywords.length === 0) continue;

    // Store for search
    allEmojis.push({ emoji, keywords });

    // Check if this is a flag emoji (Regional Indicator Symbols U+1F1E6 to U+1F1FF)
    const codePoints = [...emoji].map(c => c.codePointAt(0) || 0);
    const isFlag = codePoints.some(cp => cp >= 0x1F1E6 && cp <= 0x1F1FF);

    if (isFlag) {
      categorizedEmojis.get('Flags')!.push(emoji);
      continue;
    }

    // Find matching category by keywords
    let matched = false;
    const keywordsJoined = keywords.join(' ').toLowerCase();

    for (const category of CATEGORY_DEFINITIONS) {
      if (category.name === 'Flags') continue; // Already handled above

      const categoryMatches = category.keywords.some(catKeyword =>
        keywordsJoined.includes(catKeyword)
      );

      if (categoryMatches) {
        categorizedEmojis.get(category.name)!.push(emoji);
        matched = true;
        break;
      }
    }

    // If no category matched, add to "Other"
    if (!matched) {
      categorizedEmojis.get('Other')!.push(emoji);
    }
  }
}

/**
 * Get emojis for a category
 */
function getEmojisForCategory(categoryName: string): string[] {
  initializeEmojiData();
  return categorizedEmojis?.get(categoryName) || [];
}

/**
 * Search emojis by keyword
 */
function searchEmojis(query: string, limit: number = 100): string[] {
  initializeEmojiData();
  if (!allEmojis) return [];

  const lowerQuery = query.toLowerCase();
  const results: string[] = [];

  for (const { emoji, keywords } of allEmojis) {
    if (results.length >= limit) break;

    const matches = keywords.some(kw => kw.toLowerCase().includes(lowerQuery));
    if (matches) {
      results.push(emoji);
    }
  }

  return results;
}

type CategoryId = number | 'custom';

export class EmojiPicker {
  private container: HTMLElement;
  private overlay: HTMLElement;
  private options: EmojiPickerOptions;
  private currentCategory: CategoryId = 0;
  private frequentlyUsed: string[] = [];
  private clickOutsideHandler: ((e: MouseEvent) => void) | null = null;

  constructor(options: EmojiPickerOptions) {
    this.options = options;
    this.loadFrequentlyUsed();
    initializeEmojiData(); // Pre-initialize emoji data
    // Default-tab: custom if any custom emojis are provided, otherwise first native category
    this.currentCategory = (options.customEmojis && options.customEmojis.length > 0) ? 'custom' : 0;
    this.overlay = this.createOverlay();
    this.container = this.createElement();
    this.overlay.appendChild(this.container);
  }

  /**
   * Load frequently used emojis from localStorage
   */
  private loadFrequentlyUsed(): void {
    try {
      this.frequentlyUsed = PerAccountLocalStorage.getInstance().get<string[]>(StorageKeys.EMOJI_FREQUENTLY_USED, []);
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

    PerAccountLocalStorage.getInstance().set(StorageKeys.EMOJI_FREQUENTLY_USED, this.frequentlyUsed);
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
    searchInput.className = 'emoji-picker-search input';
    searchInput.placeholder = 'Search emoji...';
    searchInput.addEventListener('input', (e) => this.handleSearch((e.target as HTMLInputElement).value));

    // Category tabs
    const tabs = document.createElement('div');
    tabs.className = 'tabs';

    // Custom emojis tab — only when the picker is given a non-empty custom pack
    const hasCustom = !!(this.options.customEmojis && this.options.customEmojis.length > 0);
    if (hasCustom) {
      const firstCustom = this.options.customEmojis![0]!;
      const customTab = document.createElement('button');
      customTab.className = `tab ${this.currentCategory === 'custom' ? 'tab--active' : ''}`;
      customTab.title = 'Custom';
      customTab.dataset.category = 'custom';
      customTab.innerHTML = `<img class="custom-emoji" src="${firstCustom.url.replace(/"/g, '&quot;')}" alt="Custom" loading="lazy" />`;
      customTab.addEventListener('click', () => this.switchCategory('custom'));
      tabs.appendChild(customTab);
    }

    CATEGORY_DEFINITIONS.forEach((category, index) => {
      const tab = document.createElement('button');
      tab.className = `tab ${this.currentCategory === index ? 'tab--active' : ''}`;
      tab.textContent = category.icon;
      tab.title = category.name;
      tab.dataset.category = String(index);
      tab.addEventListener('click', () => this.switchCategory(index));
      tabs.appendChild(tab);
    });

    // Emoji grid container
    const gridContainer = document.createElement('div');
    gridContainer.className = 'emoji-picker-grid-container';

    // Initial grid render based on current category
    if (this.currentCategory === 'custom' && hasCustom) {
      gridContainer.appendChild(this.createCustomEmojiSection(this.options.customEmojis!));
    } else if (typeof this.currentCategory === 'number') {
      if (this.frequentlyUsed.length > 0 && this.currentCategory === 0) {
        gridContainer.appendChild(this.createEmojiSection('Frequently Used', this.frequentlyUsed));
      }
      const cat = CATEGORY_DEFINITIONS[this.currentCategory];
      if (cat) {
        const emojis = getEmojisForCategory(cat.name);
        gridContainer.appendChild(this.createEmojiSection(cat.name, emojis));
      }
    }

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
   * Create a section for NIP-30 custom emojis
   */
  private createCustomEmojiSection(customEmojis: CustomEmojiEntry[]): HTMLElement {
    const section = document.createElement('div');
    section.className = 'emoji-picker-category';

    const titleEl = document.createElement('div');
    titleEl.className = 'emoji-picker-category-title';
    titleEl.textContent = 'Custom';
    section.appendChild(titleEl);

    const grid = document.createElement('div');
    grid.className = 'emoji-picker-grid';

    customEmojis.forEach(entry => {
      const btn = document.createElement('button');
      btn.className = 'emoji-picker-emoji emoji-picker-emoji--custom';
      btn.title = `:${entry.shortcode}:`;
      btn.innerHTML = `<img class="custom-emoji" src="${entry.url.replace(/"/g, '&quot;')}" alt=":${entry.shortcode}:" loading="lazy" />`;
      btn.addEventListener('click', () => {
        if (this.options.onCustomSelect) {
          this.options.onCustomSelect(entry);
        } else {
          this.options.onSelect(`:${entry.shortcode}:`);
        }
      });
      grid.appendChild(btn);
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
  private switchCategory(category: CategoryId): void {
    this.currentCategory = category;

    // Update active tab — match by data-category attribute
    const tabs = this.container.querySelectorAll<HTMLElement>('.tab');
    tabs.forEach(tab => {
      tab.classList.toggle('tab--active', tab.dataset.category === String(category));
    });

    // Auto-scroll active tab into view
    const activeTab = this.container.querySelector<HTMLElement>(`.tab[data-category="${category}"]`);
    if (activeTab) {
      activeTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }

    // Re-render grid
    const gridContainer = this.container.querySelector('.emoji-picker-grid-container');
    if (!gridContainer) return;

    gridContainer.innerHTML = '';

    if (category === 'custom') {
      if (this.options.customEmojis && this.options.customEmojis.length > 0) {
        gridContainer.appendChild(this.createCustomEmojiSection(this.options.customEmojis));
      }
      return;
    }

    // Add frequently used if on first native category
    if (this.frequentlyUsed.length > 0 && category === 0) {
      gridContainer.appendChild(this.createEmojiSection('Frequently Used', this.frequentlyUsed));
    }

    const def = CATEGORY_DEFINITIONS[category];
    if (def) {
      const emojis = getEmojisForCategory(def.name);
      gridContainer.appendChild(this.createEmojiSection(def.name, emojis));
    }
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

    const searchResults = searchEmojis(query, 100);

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
