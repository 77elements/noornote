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
export class NotificationsRuntime implements ModuleRuntime<NotificationsModuleApi> {
  private orchestrator: import('../../services/orchestration/NotificationsOrchestrator').NotificationsOrchestrator | null = null;

  async init(_ctx: ModuleContext): Promise<void> {
    const { NotificationsOrchestrator } = await import('../../services/orchestration/NotificationsOrchestrator');
    this.orchestrator = NotificationsOrchestrator.getInstance();
  }

  async destroy(): Promise<void> {
    this.orchestrator = null;
  }

  getApi(): NotificationsModuleApi {
    const orch = this.orchestrator;
    return {
      getUnreadCount: () => orch?.getUnreadCount() ?? 0,
      getHighestUnreadPriority: () => orch?.getHighestUnreadPriority() ?? null,
      refreshSubscriptions: () => orch?.refreshSubscriptions() ?? Promise.resolve(),
      refreshMutedUsers: () => orch?.refreshMutedUsers() ?? Promise.resolve(),
      markAsRead: () => orch?.markAsRead(),
      start: () => orch?.start() ?? Promise.resolve(),
      stop: () => orch?.stop(),
    };
  }
}

export default new NotificationsRuntime();
