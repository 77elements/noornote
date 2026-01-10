/**
 * SignatureVerificationService - Cryptographic Verification for Nostr Events
 *
 * Single Responsibility: Verify event signatures and IDs to prevent forgery attacks
 *
 * Security Properties:
 * - NEVER trusts sender-provided event.id (recalculates from scratch)
 * - Verifies Schnorr signatures using nostr-tools
 * - Prevents cache poisoning and impersonation attacks
 *
 * Performance:
 * - Schnorr verification is fast (~1ms per event)
 * - Idempotent: verifySignature() caches result in event[verifiedSymbol]
 *
 * Based on: "Practical Attacks on Nostr" research paper (Vulnerability 2-4)
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { calculateEventHash, verifyEventSignature } from '../NostrToolsAdapter';
import { SystemLogger } from '../../components/system/SystemLogger';

export interface VerificationResult {
  /** True if event is cryptographically valid */
  valid: boolean;
  /** Error message if verification failed */
  error?: string;
  /** Recalculated event ID (NEVER trust sender's ID) */
  calculatedId?: string;
}

export class SignatureVerificationService {
  private static instance: SignatureVerificationService;
  private systemLogger: SystemLogger;

  /** Performance metrics (optional, can be disabled in production) */
  private verificationCount = 0;
  private failureCount = 0;

  private constructor() {
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): SignatureVerificationService {
    if (!SignatureVerificationService.instance) {
      SignatureVerificationService.instance = new SignatureVerificationService();
    }
    return SignatureVerificationService.instance;
  }

  /**
   * Verify event signature and ID authenticity
   *
   * Security Checks:
   * 1. Recalculate event ID from raw data (NEVER trust sender)
   * 2. Compare calculated ID with sender-provided ID
   * 3. Verify Schnorr signature with nostr-tools
   *
   * Performance: Idempotent - verifySignature() caches result in event[verifiedSymbol]
   *
   * @param event - Nostr event to verify
   * @returns VerificationResult with validity status
   */
  public verifyEvent(event: NostrEvent): VerificationResult {
    this.verificationCount++;

    try {
      // Performance: verifyEventSignature() is idempotent (caches result)
      // Security Check: Verify Schnorr signature FIRST (includes ID check internally)
      const signatureValid = verifyEventSignature(event);

      if (!signatureValid) {
        this.failureCount++;

        // Double-check: Recalculate ID to provide detailed error message
        // Cast to UnsignedEvent fields which calculateEventHash needs
        const calculatedId = calculateEventHash({
          kind: event.kind ?? 1,
          tags: event.tags,
          content: event.content,
          created_at: event.created_at,
          pubkey: event.pubkey
        });
        const isIdMismatch = calculatedId !== event.id;
        const eventIdPrefix = event.id?.slice(0, 8) ?? 'unknown';

        this.systemLogger.warn(
          'SignatureVerificationService',
          `⚠️ Invalid ${isIdMismatch ? 'event ID' : 'signature'} for event ${eventIdPrefix} from pubkey ${event.pubkey.slice(0, 8)}`
        );

        return {
          valid: false,
          error: isIdMismatch ? 'Event ID mismatch - possible forgery attempt' : 'Invalid cryptographic signature',
          calculatedId
        };
      }

      // Event is cryptographically valid - id is guaranteed to exist after successful verification
      const result: VerificationResult = { valid: true };
      if (event.id) {
        result.calculatedId = event.id;
      }
      return result;
    } catch (error) {
      this.failureCount++;
      this.systemLogger.error('SignatureVerificationService', `Verification error: ${error}`);
      return {
        valid: false,
        error: `Verification exception: ${error}`
      };
    }
  }

  /**
   * Batch verify multiple events (more efficient for large sets)
   *
   * @param events - Array of events to verify
   * @returns Map of event IDs to verification results
   */
  public verifyBatch(events: NostrEvent[]): Map<string, VerificationResult> {
    const results = new Map<string, VerificationResult>();

    for (const event of events) {
      const result = this.verifyEvent(event);
      // Use calculated ID from result if available, otherwise use event.id or skip
      const eventId = result.calculatedId ?? event.id;
      if (eventId) {
        results.set(eventId, result);
      }
    }

    return results;
  }

  /**
   * Get verification statistics (useful for debugging)
   */
  public getStats(): {
    totalVerifications: number;
    failures: number;
    successRate: string;
  } {
    const successRate =
      this.verificationCount > 0
        ? ((1 - this.failureCount / this.verificationCount) * 100).toFixed(1)
        : '100.0';

    return {
      totalVerifications: this.verificationCount,
      failures: this.failureCount,
      successRate: `${successRate}%`
    };
  }

  /**
   * Reset statistics (useful for testing)
   */
  public resetStats(): void {
    this.verificationCount = 0;
    this.failureCount = 0;
  }
}
