/**
 * Profile Blinking Utilities
 * Manages alternating profile pictures and usernames for profile recognition
 *
 * Usage:
 * const picBlinker = new ProfileBlinker(imgElement);
 * picBlinker.start(currentPicUrl, firstEncounterPicUrl);
 *
 * const nameBlinker = new TextBlinker(nameElement);
 * nameBlinker.start(currentName, firstEncounterName);
 */

const BLINK_INTERVAL = 2000; // 2 seconds
const TRANSITION_DURATION = 300; // 300ms (matches CSS transition)

/**
 * Text Blinking Utility
 * Manages alternating text content (usernames)
 */
export class TextBlinker {
  private textElement: HTMLElement;
  private interval: ReturnType<typeof setInterval> | null = null;
  private showFirst: boolean = true;

  constructor(textElement: HTMLElement) {
    this.textElement = textElement;

    // Ensure element has transition
    if (!this.textElement.style.transition) {
      this.textElement.style.transition = 'opacity 0.3s ease';
    }
  }

  /**
   * Start blinking between two text values
   */
  public start(currentText: string, firstEncounterText: string): void {
    // Don't start if already blinking or if texts are the same
    if (this.interval || currentText === firstEncounterText) {
      return;
    }

    // Start with current text showing
    this.textElement.textContent = currentText;
    this.textElement.style.opacity = '1';
    this.showFirst = false;

    // Start blinking interval
    this.interval = setInterval(() => {
      // Fade out
      this.textElement.style.opacity = '0';

      // Swap text after fade completes
      setTimeout(() => {
        this.textElement.textContent = this.showFirst ? firstEncounterText : currentText;
        this.textElement.style.opacity = '1';
        this.showFirst = !this.showFirst;
      }, TRANSITION_DURATION);
    }, BLINK_INTERVAL);
  }

  /**
   * Stop blinking and show current text
   */
  public stop(currentText?: string): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    // Reset to current text if provided
    if (currentText) {
      this.textElement.style.opacity = '0';
      setTimeout(() => {
        this.textElement.textContent = currentText;
        this.textElement.style.opacity = '1';
      }, TRANSITION_DURATION);
    }
  }

  /**
   * Check if currently blinking
   */
  public isBlinking(): boolean {
    return this.interval !== null;
  }

  /**
   * Cleanup on destroy
   */
  public destroy(): void {
    this.stop();
  }
}

/**
 * Profile Picture Blinking Utility
 * Manages alternating profile pictures
 */

export class ProfileBlinker {
  private imgElement: HTMLImageElement;
  private interval: ReturnType<typeof setInterval> | null = null;
  private showFirst: boolean = true;

  constructor(imgElement: HTMLImageElement) {
    this.imgElement = imgElement;

    // Ensure element has transition
    if (!this.imgElement.style.transition) {
      this.imgElement.style.transition = 'opacity 0.3s ease';
    }
  }

  /**
   * Start blinking between two profile pictures
   */
  public start(currentPic: string, firstEncounterPic: string): void {
    // Don't start if already blinking or if pics are the same
    if (this.interval || currentPic === firstEncounterPic) {
      return;
    }

    // Start with current pic showing
    this.imgElement.src = currentPic;
    this.imgElement.style.opacity = '1';
    this.showFirst = false;

    // Start blinking interval
    this.interval = setInterval(() => {
      // Fade out
      this.imgElement.style.opacity = '0';

      // Swap image after fade completes
      setTimeout(() => {
        this.imgElement.src = this.showFirst ? firstEncounterPic : currentPic;
        this.imgElement.style.opacity = '1';
        this.showFirst = !this.showFirst;
      }, TRANSITION_DURATION);
    }, BLINK_INTERVAL);
  }

  /**
   * Stop blinking and show current picture
   */
  public stop(currentPic?: string): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    // Reset to current pic if provided
    if (currentPic) {
      this.imgElement.style.opacity = '0';
      setTimeout(() => {
        this.imgElement.src = currentPic;
        this.imgElement.style.opacity = '1';
      }, TRANSITION_DURATION);
    }
  }

  /**
   * Check if currently blinking
   */
  public isBlinking(): boolean {
    return this.interval !== null;
  }

  /**
   * Cleanup on destroy
   */
  public destroy(): void {
    this.stop();
  }
}
