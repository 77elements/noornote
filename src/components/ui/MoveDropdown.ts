/**
 * MoveDropdown Component
 * Reusable "Move to..." button + dropdown for moving items between folders/zones.
 * Browser-only (not shown in desktop app where mouse drag works).
 */

import { PlatformService } from '../../services/PlatformService';

export interface MoveTarget {
  id: string;
  label: string;
}

interface MoveDropdownOptions {
  targets: MoveTarget[];
  onSelect: (targetId: string) => void;
  ariaLabel?: string;
}

export class MoveDropdown {
  private button: HTMLButtonElement;
  private dropdown: HTMLElement | null = null;
  private onSelect: (targetId: string) => void;
  private targets: MoveTarget[];
  private boundClose: (e: MouseEvent) => void;
  private boundEscape: (e: KeyboardEvent) => void;

  constructor(options: MoveDropdownOptions) {
    this.targets = options.targets;
    this.onSelect = options.onSelect;

    this.button = document.createElement('button');
    this.button.className = 'btn btn--mini btn--secondary move-dropdown__trigger';
    this.button.setAttribute('aria-label', options.ariaLabel || 'Move to...');
    this.button.title = 'Move to...';
    this.button.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9l-3 3 3 3"/><path d="M9 5l3-3 3 3"/><path d="M15 19l3 3 3-3"/><path d="M19 15l3-3-3-3"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>`;

    this.boundClose = (e: MouseEvent) => {
      if (this.dropdown && !this.dropdown.contains(e.target as Node) && !this.button.contains(e.target as Node)) {
        this.close();
      }
    };
    this.boundEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.close();
    };

    this.button.addEventListener('click', (e) => {
      e.stopPropagation();
      this.dropdown ? this.close() : this.open();
    });
  }

  private open(): void {
    if (this.targets.length === 0) return;

    this.dropdown = document.createElement('div');
    this.dropdown.className = 'move-dropdown__menu';

    this.targets.forEach(target => {
      const item = document.createElement('div');
      item.className = 'move-dropdown__item';
      item.textContent = target.label;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onSelect(target.id);
        this.close();
      });
      this.dropdown!.appendChild(item);
    });

    document.body.appendChild(this.dropdown);
    this.positionDropdown();

    document.addEventListener('click', this.boundClose);
    document.addEventListener('keydown', this.boundEscape);
  }

  private positionDropdown(): void {
    if (!this.dropdown) return;

    const rect = this.button.getBoundingClientRect();
    const dropdownHeight = this.dropdown.offsetHeight;
    const spaceBelow = window.innerHeight - rect.bottom;

    this.dropdown.style.left = `${rect.left}px`;

    if (spaceBelow < dropdownHeight && rect.top > dropdownHeight) {
      this.dropdown.style.top = `${rect.top - dropdownHeight - 4}px`;
    } else {
      this.dropdown.style.top = `${rect.bottom + 4}px`;
    }
  }

  private close(): void {
    if (this.dropdown) {
      this.dropdown.remove();
      this.dropdown = null;
    }
    document.removeEventListener('click', this.boundClose);
    document.removeEventListener('keydown', this.boundEscape);
  }

  /** Update targets dynamically (e.g. after folder changes) */
  public setTargets(targets: MoveTarget[]): void {
    this.targets = targets;
  }

  public getElement(): HTMLButtonElement {
    return this.button;
  }

  public destroy(): void {
    this.close();
    this.button.remove();
  }

  /** Returns true if MoveDropdown should be shown (browser only) */
  static shouldShow(): boolean {
    return PlatformService.getInstance().isBrowser;
  }
}
