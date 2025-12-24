/**
 * Debug Logger Component
 * Live debug logging with auto-scroll for debugging Timeline and Profile issues
 * Split into 2 sections: Global (AppState, Router, UserService) + Page-specific (Timeline/SNV/Profile)
 * Local logs are filtered by current Router view
 */

import { Router } from '../../services/Router';

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
  'NWCService'
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
  private maxGlobalLogs = 1000; // Tauri: Keep last 1000 global logs (web: 100)
  private maxPageLogs = 5000; // Tauri: Keep last 5000 page logs (web: 500)
  private globalAutoScroll = true;
  private pageAutoScroll = true;

  private constructor() {
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
      this.renderPageLogs();
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
        <div class="system-logger__global-header heading--sidebar-subheading">Global</div>
        <div class="system-logger__global-content">
          <div class="system-logger__global-logs"></div>
        </div>
      </div>
      <div class="system-logger__page debug-section">
        <div class="system-logger__page-header heading--sidebar-subheading">Local</div>
        <div class="system-logger__page-content">
          <div class="system-logger__page-logs"></div>
        </div>
      </div>
    `;

    // Setup scroll detection for both sections
    const globalContent = container.querySelector('.system-logger__global-content');
    if (globalContent) {
      globalContent.addEventListener('scroll', () => this.handleGlobalScroll());
    }

    const pageContent = container.querySelector('.system-logger__page-content');
    if (pageContent) {
      pageContent.addEventListener('scroll', () => this.handlePageScroll());
    }

    return container;
  }

  /**
   * Setup global console override for automatic logging
   */
  private setupGlobalLogging(): void {
    // Store original console methods
    const originalConsole = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug
    };

    // Override console methods to also log to our debug logger
    console.log = (...args) => {
      originalConsole.log(...args);
      this.log('info', 'Console', args.join(' '));
    };

    console.info = (...args) => {
      originalConsole.info(...args);
      this.log('info', 'Console', args.join(' '));
    };

    console.warn = (...args) => {
      originalConsole.warn(...args);
      const message = args.join(' ');

      // Filter out localhost:3000 image loading errors from UI (but keep in DevTools)
      if (message.includes('localhost:3000') && message.includes('Failed to load')) {
        return; // Don't show in System Log UI
      }

      this.log('warn', 'Console', message);
    };

    console.error = (...args) => {
      originalConsole.error(...args);

      const message = args.join(' ');

      // Handle "bad response" relay errors gracefully (expected behavior)
      if (message.includes('bad response') || message.includes('WebSocket connection')) {
        // Extract relay URL from error message
        const relayMatch = message.match(/wss?:\/\/[^\s]+/);
        const relay = relayMatch ? relayMatch[0] : 'unknown relay';
        this.log('warn', 'NostrTransport', `⚠️ Relay connection issue: ${relay} (expected - some user relays may be offline)`, { rawError: message });
      } else {
        this.log('error', 'Console', message);
      }
    };

    // Note: console.debug is NOT forwarded to SystemLogger
    // Use console.debug for DevTools-only debug output
    // Use this.debug() for SystemLogger output
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
    // Determine if this is a global or page log
    const logCategory: LogCategory = GLOBAL_CATEGORIES.includes(category) ? 'global' : 'page';

    // Normalize message for deduplication (remove dynamic parts like #26, IDs, etc.)
    const normalizedMessage = this.normalizeMessageForDeduplication(message);

    // Check if similar log already exists (category + normalized message match)
    const logs = logCategory === 'global' ? this.globalLogs : this.pageLogs;
    const existingLog = logs.find(log =>
      log.category === category &&
      this.normalizeMessageForDeduplication(log.message) === normalizedMessage &&
      log.level === level
    );

    if (existingLog) {
      // Increment counter for duplicate log
      existingLog.count = (existingLog.count || 1) + 1;
      existingLog.timestamp = Date.now(); // Update timestamp to latest occurrence

      // Re-render to show updated count
      if (logCategory === 'global') {
        this.renderGlobalLogs();
      } else {
        this.renderPageLogs();
      }
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

    // Add to appropriate log array
    if (logCategory === 'global') {
      this.globalLogs.push(entry);
      // Keep only last N global logs
      if (this.globalLogs.length > this.maxGlobalLogs) {
        this.globalLogs = this.globalLogs.slice(-this.maxGlobalLogs);
      }
      this.renderGlobalLogs();
      if (this.globalAutoScroll) {
        this.scrollGlobalToBottom();
      }
    } else {
      this.pageLogs.push(entry);
      // Keep only last N page logs
      if (this.pageLogs.length > this.maxPageLogs) {
        this.pageLogs = this.pageLogs.slice(-this.maxPageLogs);
      }
      this.renderPageLogs();
      if (this.pageAutoScroll) {
        this.scrollPageToBottom();
      }
    }
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
   * Render global logs to UI
   */
  private renderGlobalLogs(): void {
    const logsContainer = this.element.querySelector('.system-logger__global-logs');
    if (!logsContainer) return;

    logsContainer.innerHTML = this.globalLogs.map(entry => this.renderLogEntry(entry)).join('');
  }



  /**
   * Render page logs to UI (filtered by current Router view)
   */
  private renderPageLogs(): void {
    const logsContainer = this.element.querySelector('.system-logger__page-logs');
    if (!logsContainer) return;

    // Prevent circular dependency: Don't initialize Router during early app startup
    // Router will trigger re-render via 'router:view-changed' event once initialized
    if (!this.router) {
      // Queue logs, but don't render yet (Router not initialized)
      return;
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

    logsContainer.innerHTML = visibleLogs.map(entry => this.renderLogEntry(entry)).join('');
  }

  /**
   * Render individual log entry
   */
  private renderLogEntry(entry: LogEntry): string {
    const timestamp = entry.timestamp || Date.now();
    const time = new Date(timestamp).toLocaleTimeString();
    const levelClass = `system-log-entry--${entry.level}`;
    const dataHtml = entry.data ? `<pre class="system-log-entry__data">${JSON.stringify(entry.data, null, 2)}</pre>` : '';

    // Abbreviate "Orchestrator" to "Orch." in category names
    let category = entry.category.replace('Orchestrator', 'Orch.');

    // Truncate if longer than 14 characters
    if (category.length > 14) {
      category = category.substring(0, 12) + '..';
    }

    // Add count suffix if log occurred more than once
    const countSuffix = (entry.count && entry.count > 1) ? ` (${entry.count})` : '';

    return `
      <div class="system-log-entry ${levelClass}">
        <span class="system-log-entry__time">${time}</span>
        <span class="system-log-entry__category">[${category}]</span>
        <span class="system-log-entry__message">${this.escapeHtml(entry.message)}${countSuffix}</span>
        ${dataHtml}
      </div>
    `;
  }

  /**
   * Escape HTML for safe display
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Scroll global section to bottom
   */
  private scrollGlobalToBottom(): void {
    const content = this.element.querySelector('.system-logger__global-content');
    if (content) {
      content.scrollTop = content.scrollHeight;
    }
  }

  /**
   * Scroll page section to bottom
   */
  private scrollPageToBottom(): void {
    const content = this.element.querySelector('.system-logger__page-content');
    if (content) {
      content.scrollTop = content.scrollHeight;
    }
  }

  /**
   * Handle global section scroll events
   */
  private handleGlobalScroll(): void {
    const content = this.element.querySelector('.system-logger__global-content');
    if (!content) return;

    const isAtBottom = content.scrollTop + content.clientHeight >= content.scrollHeight - 10;

    // Toggle auto-scroll based on scroll position
    if (isAtBottom && !this.globalAutoScroll) {
      this.globalAutoScroll = true; // Re-enable if user scrolled back to bottom
    } else if (!isAtBottom && this.globalAutoScroll) {
      this.globalAutoScroll = false; // Disable if user scrolled up
    }
  }

  /**
   * Handle page section scroll events
   */
  private handlePageScroll(): void {
    const content = this.element.querySelector('.system-logger__page-content');
    if (!content) return;

    const isAtBottom = content.scrollTop + content.clientHeight >= content.scrollHeight - 10;

    // Toggle auto-scroll based on scroll position
    if (isAtBottom && !this.pageAutoScroll) {
      this.pageAutoScroll = true; // Re-enable if user scrolled back to bottom
    } else if (!isAtBottom && this.pageAutoScroll) {
      this.pageAutoScroll = false; // Disable if user scrolled up
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
   * @param category - Log category to filter
   * @param message - Exact message to remove
   */
  public removeLog(category: string, message: string): void {
    const logCategory: LogCategory = GLOBAL_CATEGORIES.includes(category) ? 'global' : 'page';

    if (logCategory === 'global') {
      this.globalLogs = this.globalLogs.filter(
        entry => !(entry.category === category && entry.message === message)
      );
      this.renderGlobalLogs();
    } else {
      this.pageLogs = this.pageLogs.filter(
        entry => !(entry.category === category && entry.message === message)
      );
      this.renderPageLogs();
    }
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