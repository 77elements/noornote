/**
 * CrashLogger - Persistent crash logging for debugging
 *
 * Writes all SystemLogger logs + error context to a file when crashes occur.
 * Uses Tauri's log plugin for cross-platform file logging.
 *
 * Log locations:
 * - Linux: ~/.local/share/com.noornote.desktop/logs/
 * - macOS: ~/Library/Logs/com.noornote.desktop/
 */

import { error as tauriError, info as tauriInfo, attachConsole } from '@tauri-apps/plugin-log';
import { SystemLogger, type LogEntry } from '../components/system/SystemLogger';
import { PlatformService } from './PlatformService';

class CrashLoggerService {
  private static instance: CrashLoggerService;
  private initialized = false;
  private systemLogger: SystemLogger | null = null;

  private constructor() {}

  public static getInstance(): CrashLoggerService {
    if (!CrashLoggerService.instance) {
      CrashLoggerService.instance = new CrashLoggerService();
    }
    return CrashLoggerService.instance;
  }

  /**
   * Initialize crash logging - call once at app startup
   */
  public async init(): Promise<void> {
    if (this.initialized) return;
    if (!PlatformService.getInstance().isTauri) return;

    try {
      // Attach console to Tauri log plugin (forwards console.* to file)
      await attachConsole();

      // Get SystemLogger instance for accessing logs
      this.systemLogger = SystemLogger.getInstance();

      // Setup global error handlers
      this.setupGlobalErrorHandlers();

      this.initialized = true;
      await tauriInfo('[CrashLogger] Initialized - crash logs will be saved to OS log directory');
    } catch (err) {
      // Silently fail if not in Tauri environment (e.g., during testing)
      console.warn('[CrashLogger] Could not initialize:', err);
    }
  }

  /**
   * Setup global error handlers for uncaught errors and promise rejections
   */
  private setupGlobalErrorHandlers(): void {
    // Catch uncaught errors
    window.addEventListener('error', (event) => {
      this.logCrash('UncaughtError', event.error || event.message, {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno
      });
    });

    // Catch unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
      this.logCrash('UnhandledPromiseRejection', event.reason);
    });
  }

  /**
   * Log a crash with full context from SystemLogger
   */
  public async logCrash(type: string, error: unknown, extra?: Record<string, unknown>): Promise<void> {
    try {
      const timestamp = new Date().toISOString();
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      // Build crash report
      const crashReport = [
        '========================================',
        `CRASH REPORT - ${timestamp}`,
        '========================================',
        '',
        `Type: ${type}`,
        `Error: ${errorMessage}`,
        errorStack ? `Stack:\n${errorStack}` : '',
        '',
        '--- Extra Context ---',
        extra ? JSON.stringify(extra, null, 2) : 'None',
        '',
        '--- System Logs (Recent) ---',
        this.getRecentLogs(),
        '',
        '========================================'
      ].join('\n');

      // Write to Tauri log file
      await tauriError(crashReport);

      // Also log to console for dev visibility
      console.error('[CrashLogger] Crash logged:', type, errorMessage);
    } catch (logError) {
      // Last resort - at least try console
      console.error('[CrashLogger] Failed to write crash log:', logError);
      console.error('[CrashLogger] Original error:', type, error);
    }
  }

  /**
   * Get recent logs from SystemLogger formatted as string
   */
  private getRecentLogs(): string {
    if (!this.systemLogger) {
      return 'SystemLogger not available';
    }

    try {
      // Access internal logs via the SystemLogger
      // We need to expose logs - for now use a workaround via global/page logs
      const logs = this.getLogsFromSystemLogger();

      if (logs.length === 0) {
        return 'No recent logs';
      }

      return logs
        .slice(-100) // Last 100 entries
        .map(entry => this.formatLogEntry(entry))
        .join('\n');
    } catch {
      return 'Could not retrieve logs';
    }
  }

  /**
   * Get logs from SystemLogger (accessing internal state)
   */
  private getLogsFromSystemLogger(): LogEntry[] {
    // SystemLogger stores logs internally - we access them via the instance
    // This requires exposing logs or using a getter method
    const logger = this.systemLogger as any;
    const globalLogs: LogEntry[] = logger.globalLogs || [];
    const pageLogs: LogEntry[] = logger.pageLogs || [];

    // Combine and sort by timestamp
    return [...globalLogs, ...pageLogs].sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Format a log entry for the crash report
   */
  private formatLogEntry(entry: LogEntry): string {
    const time = new Date(entry.timestamp).toISOString();
    const level = entry.level.toUpperCase().padEnd(5);
    const category = entry.category.padEnd(20);
    const count = entry.count && entry.count > 1 ? ` (x${entry.count})` : '';
    return `[${time}] ${level} [${category}] ${entry.message}${count}`;
  }

  /**
   * Manually log a critical error (call from ErrorService for severe errors)
   */
  public async logCriticalError(context: string, error: unknown): Promise<void> {
    await this.logCrash('CriticalError', error, { context });
  }
}

export const CrashLogger = CrashLoggerService.getInstance();
