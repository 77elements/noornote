import type { ModuleRuntime, ModuleContext } from '../../core/ModuleLoader';
import type { NotificationsModuleApi } from './contracts';

/**
 * Notifications module runtime — thin wrapper around existing singletons.
 *
 * IMPORTANT: Does NOT call orchestrator.start() or articleService.startPolling()
 * here. PostLoginService already handles startup. Adding a second start() call
 * creates a race condition (both enter the async start() before ptagSubId is set,
 * causing duplicate subscriptions and phantom notifications).
 *
 * Once PostLoginService is fully migrated away, start() moves here.
 */
export class NotificationsRuntime
  implements ModuleRuntime<NotificationsModuleApi>
{
  private orchestrator:
    | import('../../services/orchestration/NotificationsOrchestrator').NotificationsOrchestrator
    | null = null;
  private cacheService:
    | import('../../services/NotificationsCacheService').NotificationsCacheService
    | null = null;

  async init(_ctx: ModuleContext): Promise<void> {
    const [orchMod, cacheMod] = await Promise.all([
      import('../../services/orchestration/NotificationsOrchestrator'),
      import('../../services/NotificationsCacheService'),
    ]);
    this.orchestrator = orchMod.NotificationsOrchestrator.getInstance();
    this.cacheService = cacheMod.NotificationsCacheService.getInstance();
  }

  async destroy(): Promise<void> {
    this.orchestrator = null;
    this.cacheService = null;
  }

  getApi(): NotificationsModuleApi {
    const orch = this.orchestrator;
    const cs = this.cacheService;
    return {
      getUnreadCount: () => orch?.getUnreadCount() ?? 0,
      getHighestUnreadPriority: () => orch?.getHighestUnreadPriority() ?? null,
      refreshSubscriptions: () =>
        orch?.refreshSubscriptions() ?? Promise.resolve(),
      refreshMutedUsers: () => orch?.refreshMutedUsers() ?? Promise.resolve(),
      markAsRead: () => orch?.markAsRead(),
      start: () => orch?.start() ?? Promise.resolve(),
      stop: () => orch?.stop(),
      getCacheLimit: () => cs?.getLimit() ?? 100,
      setCacheLimit: limit => cs?.setLimit(limit),
      updateLastSeen: () => cs?.updateLastSeen(),
      getCachedNotifications: () => cs?.getCachedNotifications() ?? [],
      getLastFetch: () => cs?.getLastFetch() ?? 0,
      addNotifications: events => cs?.addNotifications(events),
    };
  }
}

export default new NotificationsRuntime();
