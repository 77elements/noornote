import { EventBus } from '../services/EventBus';
import type { AppEvents, AppEventName } from './events';

type EventCallback<K extends AppEventName> = AppEvents[K] extends void
  ? () => void
  : (data: AppEvents[K]) => void;

export class TypedEventBus {
  private static instance: TypedEventBus;
  private bus: EventBus;

  private constructor() {
    this.bus = EventBus.getInstance();
  }

  public static getInstance(): TypedEventBus {
    if (!TypedEventBus.instance) {
      TypedEventBus.instance = new TypedEventBus();
    }
    return TypedEventBus.instance;
  }

  public on<K extends AppEventName>(
    event: K,
    callback: EventCallback<K>
  ): string {
    return this.bus.on(event, callback as any);
  }

  public once<K extends AppEventName>(
    event: K,
    callback: EventCallback<K>
  ): string {
    return this.bus.once(event, callback as any);
  }

  public emit<K extends AppEventName>(
    event: K,
    ...args: AppEvents[K] extends void ? [] : [AppEvents[K]]
  ): void {
    this.bus.emit(event, ...args);
  }

  public off(subscriptionId: string): void {
    this.bus.off(subscriptionId);
  }

  public getSubscriptionCount(eventName?: AppEventName): number {
    return this.bus.getSubscriptionCount(eventName);
  }
}
