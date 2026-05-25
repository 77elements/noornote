import type { ModuleRuntime, ModuleContext } from '../../core/ModuleLoader';
import type { NotificationsModuleApi } from './contracts';

export class NotificationsRuntime implements ModuleRuntime<NotificationsModuleApi> {
  private orchestrator: import('../../services/orchestration/NotificationsOrchestrator').NotificationsOrchestrator | null = null;
  private articleService: import('../../services/ArticleNotificationService').ArticleNotificationService | null = null;

  async init(_ctx: ModuleContext): Promise<void> {
    const { NotificationsOrchestrator } = await import('../../services/orchestration/NotificationsOrchestrator');
    const { ArticleNotificationService } = await import('../../services/ArticleNotificationService');

    this.orchestrator = NotificationsOrchestrator.getInstance();
    this.articleService = ArticleNotificationService.getInstance();

    await this.orchestrator.start();
    this.articleService.startPolling();
  }

  async destroy(): Promise<void> {
    this.orchestrator?.stop();
    this.articleService?.stopPolling();
    this.orchestrator = null;
    this.articleService = null;
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
