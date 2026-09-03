/**
 * CrashLogger - Persistent crash logging via DiagnosticLogger
 *
 * Routes all crash/error data to ~/.noornote/{npub}/logs/crashes.jsonl
 * via DiagnosticLogger (single point of truth for all diagnostic logs).
 *
 * Captures:
 * - Uncaught errors (window.onerror)
 * - Unhandled promise rejections
 * - Critical errors from ErrorService
 * - Manual logCrash() calls
 */

import { SystemLogger, type LogEntry } from './SystemLogger';
import { diagLog } from './DiagnosticLogger';

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

    try {
      this.systemLogger = SystemLogger.getInstance();
      this.setupGlobalErrorHandlers();
      this.initialized = true;
      diagLog('crashes', 'CrashLogger initialized');
    } catch (err) {
      console.debug('[CrashLogger] Could not initialize:', err);
    }
  }

  /**
   * Setup global error handlers for uncaught errors and promise rejections
   */
  private setupGlobalErrorHandlers(): void {
    window.addEventListener('error', event => {
      this.logCrash('UncaughtError', event.error || event.message, {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      });
    });

    window.addEventListener('unhandledrejection', event => {
      // NDK v3 throws on events with invalid tags (e.g. number instead of string).
      // These are malformed events from other clients — not our bug, not a crash.
      const msg = String(event.reason);
      if (msg.includes("Can't serialize event with invalid properties")) {
        event.preventDefault();
        return;
      }

      this.logCrash('UnhandledPromiseRejection', event.reason);
    });
  }

  /**
   * Log a crash with full context from SystemLogger
   */
  public logCrash(
    type: string,
    error: unknown,
    extra?: Record<string, unknown>
  ): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    diagLog('crashes', `${type}: ${errorMessage}`, {
      type,
      error: errorMessage,
      stack: errorStack,
      extra,
      recentLogs: this.getRecentLogs(),
    });

    console.error(`[CrashLogger] ${type}:`, errorMessage);
  }

  /**
   * Get recent logs from SystemLogger as structured array
   */
  private getRecentLogs(): Record<string, unknown>[] {
    if (!this.systemLogger) return [];

    try {
      const logs = this.getLogsFromSystemLogger();
      return logs.slice(-50).map(entry => ({
        time: new Date(entry.timestamp).toISOString(),
        level: entry.level,
        category: entry.category,
        message: entry.message,
        count: entry.count && entry.count > 1 ? entry.count : undefined,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Get logs from SystemLogger (accessing internal state)
   */
  private getLogsFromSystemLogger(): LogEntry[] {
    const { globalLogs, pageLogs } = this.systemLogger!.getLogBuffers();
    return [...globalLogs, ...pageLogs].sort(
      (a, b) => a.timestamp - b.timestamp
    );
  }

  /**
   * Manually log a critical error (call from ErrorService for severe errors)
   */
  public logCriticalError(context: string, error: unknown): void {
    this.logCrash('CriticalError', error, { context });
  }
}

export const CrashLogger = CrashLoggerService.getInstance();
