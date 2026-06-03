/**
 * Debug Logger Component
 * Live debug logging with auto-scroll for debugging Timeline and Profile issues
 * Split into 2 sections: Global (AppState, Router, UserService) + Page-specific (Timeline/SNV/Profile)
 * Local logs are filtered by current Router view
 */

import { Router } from './Router';
import { escapeHtml } from '../helpers/escapeHtml';
import { diagLog } from './DiagnosticLogger';
import { PlatformService } from './PlatformService';

export type LogLevel = 'info' | 'debug' | 'warn' | 'error' | 'success';
export type LogCategory = 'global' | 'page';

export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  category: string;
  logCategory: LogCategory; // 'global' or 'page'
  message: string;
  data?: any;
  count?: number; // How many times this exact log occurred
}

// Global categories: System-wide infrastructure components
const GLOBAL_CATEGORIES = [
  'AppState',
  'Router',
  'UserService',
  'Auth',
  'KeySigner',
  'USM',
  'Console',
  'NostrTransport',
  'EventBus',
  'RelayConfig',
  'OrchestrationsRouter',
  'RelayListOrchestrator',
  'OutboundRelaysFetcherOrchestrator',
  'PostService',
  'ZapService',
  'NWCService',
  'BookmarkOrchestrator',
  'tribes.ts',
  'ListAutoSync',
  'DeletionService',
  'BroadcastDelete'
];

// View-specific categories mapping (Router viewClass → allowed categories)
// TV = Timeline View, SNV = Single Note View, PV = Profile View, NV = Notifications View, SV = Settings View
const VIEW_CATEGORIES: Record<string, string[]> = {
  'tv': ['FeedOrchestrator', 'TimelineUI', 'TimelineView'], // Timeline View
  'snv': ['SNV', 'SingleNoteView', 'ThreadOrchestrator', 'ReactionsOrch'], // Single Note View
  'pv': ['PV', 'ProfileView', 'ProfileOrchestrator', 'TimelineUI', 'FeedOrchestrator', 'FollowerCount'], // Profile View (includes TimelineUI for author filter)
  'nv': ['NotificationsView', 'NotificationsOrch', 'ReactionsOrch'], // Notifications View
  'sv': ['SettingsView', 'CacheManager'] // Settings View
};

export class SystemLogger {
  private static instance: SystemLogger;
  private element: HTMLElement;
  private router: Router | null = null;
  private globalLogs: LogEntry[] = [];
  private pageLogs: LogEntry[] = [];
  private maxGlobalLogs = 1000; // Desktop: Keep last 1000 global logs (web: 100)
  private maxPageLogs = 5000; // Desktop: Keep last 5000 page logs (web: 500)
  private globalAutoScroll = true;
  private pageAutoScroll = true;
  private renderScheduled = false;
  private dirty: { global: boolean; page: boolean } = { global: false, page: false };
  // On the native Android app (Capacitor) the live log panel is never reachable
  // (the secondary column is display:none) and everything is already captured by the
  // file-based DiagnosticLogger. So we skip the in-memory collection, dedup scan and
  // rendering there entirely — only the diagLog mirror runs.
  private suppressInMemory = false;

  private constructor() {
    this.suppressInMemory = PlatformService.getInstance().isCapacitor;
    this.element = this.createElement();
    this.setupGlobalLogging();
    this.setupViewChangeListener();
  }

  /**
   * Listen for Router events (view changes + navigation)
   */
  private setupViewChangeListener(): void {
    // Re-render page logs when view changes (also initializes router if needed)
    window.addEventListener('router:view-changed', () => {
      // Initialize router on first view change if not yet set
      if (!this.router) {
        this.router = Router.getInstance();
      }
      this.scheduleRender('page');
    });

    // Clear page logs on navigation (avoid circular dependency with Router)
    window.addEventListener('router:navigate', (event: any) => {
      this.clearPageLogs();
      this.info('Router', `🧹 Local logs cleared (switched to ${event.detail.path})`);
    });
  }

  public static getInstance(): SystemLogger {
    if (!SystemLogger.instance) {
      SystemLogger.instance = new SystemLogger();
    }
    return SystemLogger.instance;
  }

  /**
   * Create debug logger UI with 2 sections
   */
  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'system-logger';
    container.innerHTML = `
      <div class="system-logger__global debug-section">
        <h3 class="system-logger__global-header heading--sidebar-subheading h4">Global</h3>
        <div class="system-logger__global-content" tabindex="0" role="log" aria-label="Global logs">
          <div class="system-logger__global-logs"></div>
        </div>
      </div>
      <div class="system-logger__page debug-section">
        <h3 class="system-logger__page-header heading--sidebar-subheading h4">Local</h3>
        <div class="system-logger__page-content" tabindex="0" role="log" aria-label="Local logs">
          <div class="system-logger__page-logs"></div>
        </div>
      </div>
    `;

    // Setup scroll detection for both sections
    const globalContent = container.querySelector('.system-logger__global-content');
    if (globalContent) {
      globalContent.addEventListener('scroll', () => this.handleScroll('global'));
    }

    const pageContent = container.querySelector('.system-logger__page-content');
    if (pageContent) {
      pageContent.addEventListener('scroll', () => this.handleScroll('page'));
    }

    return container;
  }

  /**
   * Setup console.error override to surface critical errors in System Log.
   * Only console.error is intercepted — console.log/warn/info stay in DevTools only.
   * All intentional System Log entries go through systemLogger.info/warn/error() directly.
   */
  private setupGlobalLogging(): void {
    const originalError = console.error;

    console.error = (...args) => {
      originalError(...args);
      const message = args.join(' ');

      // Relay connection issues → friendly warning
      if (message.includes('bad response') || message.includes('WebSocket connection')) {
        const relayMatch = message.match(/wss?:\/\/[^\s]+/);
        const relay = relayMatch ? relayMatch[0] : 'unknown relay';
        this.log('warn', 'NostrTransport', `Relay offline: ${relay}`);
      }
    };
  }

  /**
   * Normalize message for deduplication by removing dynamic parts
   * Examples:
   * - "reply #26" → "reply #"
   * - "Loaded ✅" → "Loaded ✅"
   */
  private normalizeMessageForDeduplication(message: string): string {
    return message
      .replace(/#\d+/g, '#') // Remove numbers after # (e.g., #26 → #)
      .replace(/\b[a-f0-9]{64}\b/g, '<id>') // Replace hex IDs with placeholder
      .replace(/\d+ms/g, '<time>'); // Replace timing info
  }

  /**
   * Add log entry - automatically categorizes as global or page
   * Deduplicates repeated logs by incrementing count instead of creating new entries
   */
  public log(level: LogLevel, category: string, message: string, data?: any): void {
    // Mirror to DiagnosticLogger (writes to JSONL on mobile, no-op on web)
    diagLog('system', `[${level}] ${category}: ${message}`, data);

    // Native Android: file logging only, no in-memory panel (see suppressInMemory).
    if (this.suppressInMemory) return;

    const logCategory: LogCategory = GLOBAL_CATEGORIES.includes(category) ? 'global' : 'page';
    const normalizedMessage = this.normalizeMessageForDeduplication(message);
    const logs = logCategory === 'global' ? this.globalLogs : this.pageLogs;

    // Check if similar log already exists (category + normalized message match)
    const existingLog = logs.find(log =>
      log.category === category &&
      log.level === level &&
      this.normalizeMessageForDeduplication(log.message) === normalizedMessage
    );

    if (existingLog) {
      existingLog.count = (existingLog.count || 1) + 1;
      existingLog.timestamp = Date.now();
      this.scheduleRender(logCategory);
      return;
    }

    // New log entry
    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      category,
      logCategory,
      message,
      data,
      count: 1
    };

    // Add to appropriate log array and render
    this.addAndRenderLog(entry, logCategory);
  }

  /**
   * Add log entry to array and render
   */
  private addAndRenderLog(entry: LogEntry, logCategory: LogCategory): void {
    const isGlobal = logCategory === 'global';
    const logs = isGlobal ? this.globalLogs : this.pageLogs;
    const maxLogs = isGlobal ? this.maxGlobalLogs : this.maxPageLogs;

    logs.push(entry);

    // Keep only last N logs
    if (logs.length > maxLogs) {
      if (isGlobal) {
        this.globalLogs = this.globalLogs.slice(-maxLogs);
      } else {
        this.pageLogs = this.pageLogs.slice(-maxLogs);
      }
    }

    this.scheduleRender(logCategory);
  }

  /**
   * Coalesce renders: a burst of log events within one frame triggers a single
   * render, and rendering is skipped entirely while the panel is not visible (an
   * inactive SCC tab, or phone where the secondary column is display:none — there
   * the in-memory log arrays are still kept, just not painted). A category skipped
   * because it was hidden stays dirty and renders once the panel is shown (refresh()).
   */
  private scheduleRender(logCategory: LogCategory): void {
    if (logCategory === 'global') this.dirty.global = true;
    else this.dirty.page = true;
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => this.flushRender());
  }

  private flushRender(): void {
    this.renderScheduled = false;
    if (this.dirty.global && this.renderGlobalLogs()) this.dirty.global = false;
    if (this.dirty.page && this.renderPageLogs()) this.dirty.page = false;
  }

  /**
   * Convenience methods
   */
  public info(category: string, message: string, data?: any): void {
    this.log('info', category, message, data);
  }

  public debug(category: string, message: string, data?: any): void {
    this.log('debug', category, message, data);
  }

  public warn(category: string, message: string, data?: any): void {
    this.log('warn', category, message, data);
  }

  public error(category: string, message: string, data?: any): void {
    this.log('error', category, message, data);
  }

  public success(category: string, message: string, data?: any): void {
    this.log('success', category, message, data);
  }

  /**
   * Render logs by category
   */
  private renderLogs(logCategory: LogCategory): void {
    if (logCategory === 'global') {
      this.renderGlobalLogs();
    } else {
      this.renderPageLogs();
    }
  }

  /**
   * Render global logs to UI
   */
  private renderGlobalLogs(): boolean {
    const logsContainer = this.element.querySelector('.system-logger__global-logs') as HTMLElement | null;
    if (!logsContainer) return true;
    // Skip while not visible (inactive tab / phone display:none / detached); offsetParent
    // is null in all those cases. The caller keeps the category dirty so it renders later.
    if (logsContainer.offsetParent === null) return false;

    const visibleLogs = this.globalLogs.slice(-50);
    logsContainer.innerHTML = `<table class="system-log-table"><tbody>${visibleLogs.map(entry => this.renderLogEntry(entry)).join('')}</tbody></table>`;
    if (this.globalAutoScroll) this.scrollToBottom('global');
    return true;
  }

  /**
   * Render page logs to UI (filtered by current Router view)
   */
  private renderPageLogs(): boolean {
    const logsContainer = this.element.querySelector('.system-logger__page-logs') as HTMLElement | null;
    if (!logsContainer) return true;
    // Skip while not visible (see renderGlobalLogs); stays dirty until shown.
    if (logsContainer.offsetParent === null) return false;

    // Prevent circular dependency: Don't initialize Router during early app startup
    // Router will trigger re-render via 'router:view-changed' event once initialized
    if (!this.router) {
      // Router not ready yet → keep dirty, render after init
      return false;
    }

    // Get current view from Router
    const currentView = this.router.getCurrentView();
    const allowedCategories = VIEW_CATEGORIES[currentView] || [];

    // Filter logs by current view (only show logs relevant to active view)
    let filteredLogs = this.pageLogs;
    if (currentView && allowedCategories.length > 0) {
      filteredLogs = this.pageLogs.filter(log =>
        allowedCategories.some(cat => log.category.includes(cat))
      );
    }

    // Only render last 50 visible logs for performance
    const visibleLogs = filteredLogs.slice(-50);

    logsContainer.innerHTML = `<table class="system-log-table"><tbody>${visibleLogs.map(entry => this.renderLogEntry(entry)).join('')}</tbody></table>`;
    if (this.pageAutoScroll) this.scrollToBottom('page');
    return true;
  }

  /**
   * Render individual log entry as table row
   */
  private renderLogEntry(entry: LogEntry): string {
    const timestamp = entry.timestamp || Date.now();
    const time = new Date(timestamp).toLocaleTimeString();
    const levelClass = `system-log-entry--${entry.level}`;
    const dataHtml = entry.data ? `<pre class="system-log-entry__data">${JSON.stringify(entry.data, null, 2)}</pre>` : '';

    // Abbreviate long category names
    let category = entry.category
      .replace('Orchestrator', 'Orch.')
      .replace('NostrTransport', 'NostrTrnsp.');

    // Truncate if longer than 14 characters
    if (category.length > 14) {
      category = category.substring(0, 12) + '..';
    }

    // Add count suffix if log occurred more than once
    const countSuffix = (entry.count && entry.count > 1) ? ` (${entry.count})` : '';

    return `
      <tr class="system-log-entry ${levelClass}">
        <td class="system-log-entry__time">${time}</td>
        <td class="system-log-entry__category">[${category}]</td>
        <td class="system-log-entry__message">${escapeHtml(entry.message)}${countSuffix}${dataHtml}</td>
      </tr>
    `;
  }

  /**
   * Scroll a section to bottom by type
   */
  private scrollToBottom(section: 'global' | 'page'): void {
    const content = this.element.querySelector(`.system-logger__${section}-content`);
    if (content) {
      content.scrollTop = content.scrollHeight;
    }
  }

  /**
   * Handle scroll events for a section - toggles auto-scroll based on position
   */
  private handleScroll(section: 'global' | 'page'): void {
    const content = this.element.querySelector(`.system-logger__${section}-content`);
    if (!content) return;

    const isAtBottom = content.scrollTop + content.clientHeight >= content.scrollHeight - 10;
    const autoScrollKey = section === 'global' ? 'globalAutoScroll' : 'pageAutoScroll';

    if (isAtBottom !== this[autoScrollKey]) {
      this[autoScrollKey] = isAtBottom;
    }
  }

  /**
   * Clear all logs
   */
  public clear(): void {
    this.globalLogs = [];
    this.pageLogs = [];
    this.renderGlobalLogs();
    this.renderPageLogs();
  }

  /**
   * Clear only page logs (for view transitions)
   */
  public clearPageLogs(): void {
    this.pageLogs = [];
    this.renderPageLogs();
  }

  /**
   * Remove specific log entry by message (for clearing resolved errors)
   */
  public removeLog(category: string, message: string): void {
    const logCategory: LogCategory = GLOBAL_CATEGORIES.includes(category) ? 'global' : 'page';
    const filterFn = (entry: LogEntry) => !(entry.category === category && entry.message === message);

    if (logCategory === 'global') {
      this.globalLogs = this.globalLogs.filter(filterFn);
    } else {
      this.pageLogs = this.pageLogs.filter(filterFn);
    }
    this.renderLogs(logCategory);
  }

  /**
   * Force a render now, e.g. when the System Logs tab becomes visible. Renders only
   * if the panel is actually on screen; otherwise the dirty flags keep it pending.
   */
  public refresh(): void {
    this.dirty.global = true;
    this.dirty.page = true;
    this.flushRender();
  }

  /**
   * Get DOM element
   */
  public getElement(): HTMLElement {
    return this.element;
  }

  /**
   * Destroy logger and restore console
   */
  public destroy(): void {
    // Restore original console methods would go here if needed
    this.element.remove();
  }
}