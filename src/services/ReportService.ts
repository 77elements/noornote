/**
 * ReportService - NIP-56 Reporting Implementation
 * Handles creation and publishing of Kind 1984 report events
 *
 * NIP-56: https://github.com/nostr-protocol/nips/blob/master/56.md
 *
 * Report Types:
 * - nudity: Pornographic content
 * - malware: Viruses, trojans, spyware
 * - profanity: Hateful speech
 * - illegal: Potentially unlawful content
 * - spam: Unwanted messaging
 * - impersonation: Falsely representing another identity
 * - other: Miscellaneous reports
 */

import { AuthService } from './AuthService';
import { NostrTransport } from './transport/NostrTransport';
import { SystemLogger } from '../components/system/SystemLogger';
import { AuthGuard } from './AuthGuard';
import { ErrorService } from './ErrorService';
import { ToastService } from './ToastService';
import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';

export type ReportType =
  | 'nudity'
  | 'malware'
  | 'profanity'
  | 'illegal'
  | 'spam'
  | 'impersonation'
  | 'other';

export interface ReportOptions {
  /** Type of report */
  type: ReportType;
  /** Optional description/reason for report */
  reason?: string;
  /** Target user pubkey (mandatory) */
  reportedPubkey: string;
  /** Optional: Specific event ID being reported */
  reportedEventId?: string;
}

export class ReportService {
  private static instance: ReportService;
  private authService: AuthService;
  private transport: NostrTransport;
  private systemLogger: SystemLogger;


  private constructor() {
    this.authService = AuthService.getInstance();
    this.transport = NostrTransport.getInstance();
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): ReportService {
    if (!ReportService.instance) {
      ReportService.instance = new ReportService();
    }
    return ReportService.instance;
  }

  /**
   * Create and publish a report event (Kind 1984)
   *
   * @param options - Report configuration
   * @returns Promise<{ success: boolean; error?: string }> - Result status
   */
  public async createReport(options: ReportOptions): Promise<{ success: boolean; error?: string }> {
    const { type, reason, reportedPubkey, reportedEventId } = options;

    // Auth guard check
    if (!AuthGuard.requireAuth('report content')) {
      return { success: false, error: 'Not authenticated' };
    }

    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.systemLogger.error('ReportService', 'Cannot create report: User not authenticated');
      return { success: false, error: 'Not authenticated' };
    }

    // Validate inputs
    if (!reportedPubkey) {
      this.systemLogger.error('ReportService', 'Cannot create report: Missing reportedPubkey');
      ToastService.show('Invalid user data', 'error');
      return { success: false, error: 'Invalid user data' };
    }

    // Check for duplicate report
    if (this.hasReport(reportedPubkey, type, reportedEventId)) {
      this.systemLogger.info('ReportService', 'Report already submitted (duplicate)');
      ToastService.show('Du hast dies bereits gemeldet', 'info');
      return { success: false, error: 'Already reported' };
    }

    try {
      // Build tags according to NIP-56
      const tags: string[][] = [];

      // Mandatory: p tag with reported user pubkey
      // Format: ['p', pubkey, report-type] (3 elements as per NIP-56)
      tags.push(['p', reportedPubkey, type]);

      // Optional: e tag if reporting specific event
      // Format: ['e', event-id, report-type] (3 elements as per NIP-56)
      if (reportedEventId) {
        tags.push(['e', reportedEventId, type]);
      }

      // Build unsigned event
      const unsignedEvent = {
        kind: 1984,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: reason || '',
        pubkey: currentUser.pubkey
      };

      this.systemLogger.info('ReportService', `Publishing report: ${type}${reportedEventId ? ` on note ${reportedEventId.slice(0, 8)}...` : ''}`);

      // Sign event using browser extension
      const signedEvent = await this.authService.signEvent(unsignedEvent);

      if (!signedEvent) {
        this.systemLogger.error('ReportService', 'Failed to sign report event');
        ToastService.show('Signierung fehlgeschlagen', 'error');
        return { success: false, error: 'Signing failed' };
      }

      // Publish to write relays
      const writeRelays = this.transport.getWriteRelays();

      if (writeRelays.length === 0) {
        this.systemLogger.error('ReportService', 'No write relays configured');
        ToastService.show('Keine Relays konfiguriert', 'error');
        return { success: false, error: 'No relays configured' };
      }

      await this.transport.publishContent(signedEvent);

      this.systemLogger.info(
        'ReportService',
        `Report published to ${writeRelays.length} relay(s): ${type}`
      );

      // Store report to prevent duplicates
      this.storeReport(reportedPubkey, type, reportedEventId);

      // Show success toast
      ToastService.show('Report eingereicht', 'success');

      return { success: true };
    } catch (error) {
      // Centralized error handling with user notification
      ErrorService.handle(
        error,
        'ReportService.createReport',
        true,
        'Report konnte nicht eingereicht werden. Bitte versuche es erneut.'
      );
      return { success: false, error: 'Publish failed' };
    }
  }

  /**
   * Get human-readable label for report type
   */
  public static getReportTypeLabel(type: ReportType): string {
    const labels: Record<ReportType, string> = {
      nudity: 'Nudity / Pornographic content',
      malware: 'Malware / Harmful software',
      profanity: 'Profanity / Hate speech',
      illegal: 'Illegal content',
      spam: 'Spam',
      impersonation: 'Impersonation',
      other: 'Other'
    };

    return labels[type];
  }

  /**
   * Get description for report type
   */
  public static getReportTypeDescription(type: ReportType): string {
    const descriptions: Record<ReportType, string> = {
      nudity: 'Pornographic or sexually explicit material',
      malware: 'Viruses, trojans, spyware, or harmful software',
      profanity: 'Hateful speech, harassment, or abusive language',
      illegal: 'Content that may be unlawful in your jurisdiction',
      spam: 'Unwanted or repetitive messaging',
      impersonation: 'Falsely representing another person or entity',
      other: 'Other violations not covered by categories above'
    };

    return descriptions[type];
  }

  /**
   * Get all available report types
   */
  public static getReportTypes(): ReportType[] {
    return ['nudity', 'malware', 'profanity', 'illegal', 'spam', 'impersonation', 'other'];
  }

  /**
   * Check if a report already exists (localStorage-based)
   */
  private hasReport(reportedPubkey: string, type: ReportType, reportedEventId?: string): boolean {
    const reports = PerAccountLocalStorage.getInstance().get<Record<string, boolean>>(StorageKeys.SUBMITTED_REPORTS, {});
    const key = this.generateReportKey(reportedPubkey, type, reportedEventId);
    return reports[key] === true;
  }

  /**
   * Store a submitted report
   */
  private storeReport(reportedPubkey: string, type: ReportType, reportedEventId?: string): void {
    const reports = PerAccountLocalStorage.getInstance().get<Record<string, boolean>>(StorageKeys.SUBMITTED_REPORTS, {});
    const key = this.generateReportKey(reportedPubkey, type, reportedEventId);
    reports[key] = true;
    PerAccountLocalStorage.getInstance().set(StorageKeys.SUBMITTED_REPORTS, reports);
  }

  /**
   * Generate unique cache key for report
   * Format: pubkey:type[:eventId]
   */
  private generateReportKey(reportedPubkey: string, type: ReportType, reportedEventId?: string): string {
    const base = `${reportedPubkey}:${type}`;
    return reportedEventId ? `${base}:${reportedEventId}` : base;
  }
}
