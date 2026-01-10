/**
 * BaseInteractionManager
 * Abstract base class for interaction managers (Like, Repost, Zap)
 *
 * Consolidates common patterns:
 * - Button state management
 * - Auth checking
 * - Stats updates
 * - Interaction status tracking
 */

import { AuthGuard } from '../../../services/AuthGuard';
import { StatsUpdateService } from '../../../services/StatsUpdateService';

export interface BaseInteractionConfig {
  noteId: string;
  authorPubkey: string;
  onStatsUpdate?: () => void;
}

export abstract class BaseInteractionManager<TConfig extends BaseInteractionConfig> {
  protected config: TConfig;
  protected statsUpdateService: StatsUpdateService;
  protected button: HTMLElement | null = null;
  protected hasInteracted: boolean = false;

  constructor(config: TConfig) {
    this.config = config;
    this.statsUpdateService = StatsUpdateService.getInstance();
  }

  /**
   * Set button element reference
   */
  public setButtonElement(button: HTMLElement): void {
    this.button = button;
  }

  /**
   * Check if current user has already interacted with this note
   * Must be implemented by subclasses
   */
  public abstract checkInteractionStatus(): Promise<void>;

  /**
   * Handle interaction action
   * Must be implemented by subclasses
   */
  protected abstract handleInteraction(): void;

  /**
   * Update button visual state
   * Must be implemented by subclasses
   */
  protected abstract updateButtonState(interacted: boolean): void;

  /**
   * Update stats after successful interaction
   */
  protected updateStats(interactionType: 'like' | 'repost'): void {
    this.statsUpdateService.updateAfterInteraction(
      this.config.noteId,
      interactionType
    );

    if (this.config.onStatsUpdate) {
      this.config.onStatsUpdate();
    }
  }

  /**
   * Check authentication before interaction
   */
  protected requireAuth(action: string): boolean {
    return AuthGuard.requireAuth(action);
  }

  /**
   * Attach event listener to button
   */
  public attachEventListeners(button: HTMLElement): void {
    this.setButtonElement(button);

    button.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handleInteraction();
    });
  }

  /**
   * Destroy manager and cleanup resources
   * Can be overridden by subclasses
   */
  public destroy(): void {
    this.button = null;
  }
}
