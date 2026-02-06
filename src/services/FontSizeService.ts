/**
 * FontSizeService
 * Manages font-size scaling preference (small / default / large).
 * Applies CSS class on <html> for SCSS parent-selector overrides.
 * Per-account persistence via PerAccountLocalStorage.
 */

import { PerAccountLocalStorage, StorageKeys, type FontSizeScale } from './PerAccountLocalStorage';
import { EventBus } from './EventBus';

const SCALES: FontSizeScale[] = ['small', 'default', 'large', 'x-large'];

export class FontSizeService {
  private static instance: FontSizeService;
  private storage: PerAccountLocalStorage;
  private eventBus: EventBus;
  private currentScale: FontSizeScale = 'default';

  private constructor() {
    this.storage = PerAccountLocalStorage.getInstance();
    this.eventBus = EventBus.getInstance();
    this.currentScale = this.storage.get<FontSizeScale>(StorageKeys.FONT_SIZE_SCALE, 'default');
    this.applyClass();
  }

  public static getInstance(): FontSizeService {
    if (!FontSizeService.instance) {
      FontSizeService.instance = new FontSizeService();
    }
    return FontSizeService.instance;
  }

  public getScale(): FontSizeScale {
    return this.currentScale;
  }

  public setScale(scale: FontSizeScale): void {
    this.currentScale = scale;
    this.storage.set(StorageKeys.FONT_SIZE_SCALE, scale);
    this.applyClass();
    this.eventBus.emit('font-size:changed', { scale });
  }

  public cycleUp(): void {
    const idx = SCALES.indexOf(this.currentScale);
    const next = SCALES[idx + 1];
    if (next) this.setScale(next);
  }

  public cycleDown(): void {
    const idx = SCALES.indexOf(this.currentScale);
    const prev = SCALES[idx - 1];
    if (prev) this.setScale(prev);
  }

  /** Reload preference after account switch */
  public refresh(): void {
    this.currentScale = this.storage.get<FontSizeScale>(StorageKeys.FONT_SIZE_SCALE, 'default');
    this.applyClass();
    this.eventBus.emit('font-size:changed', { scale: this.currentScale });
  }

  private applyClass(): void {
    const html = document.documentElement;
    html.classList.remove('font-size--small', 'font-size--large', 'font-size--x-large');
    if (this.currentScale !== 'default') {
      html.classList.add(`font-size--${this.currentScale}`);
    }
  }
}
