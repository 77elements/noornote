import type { AddonContext, AddonRuntime } from '../AddonLoader';
import type { BadgeService as Service } from './BadgeService';

export class BadgesRuntime implements AddonRuntime {
  public service: Service | null = null;

  async init(_ctx: AddonContext): Promise<void> {
    if (this.service) return;
    const { BadgeService } = await import('./BadgeService');
    this.service = BadgeService.getInstance();
  }

  async destroy(): Promise<void> {
    if (!this.service) return;
    this.service.destroy();
    this.service = null;
  }
}

export default new BadgesRuntime();
