/**
 * DMExpiration — pure helpers for NIP-17 disappearing messages.
 *
 * Per-conversation setting (mirrors Nostur's model):
 *   undecided  → undefined on DMConversation (first incoming tagged
 *                message shows a request banner; never re-prompts after)
 *   off        → 0 (user declined, do not stamp outgoing, do not sweep)
 *   7d / 30d / 1y → preset duration in seconds
 *
 * Wire format (NIP-17 + NIP-40): the `expiration` tag is attached to the
 * unsigned rumor (kind 14) and the gift wrap (kind 1059). It is NOT attached
 * to the kind 13 seal — NIP-59 says seal tags MUST be empty, which contradicts
 * NIP-17's "SHOULD". NIP-59's MUST wins (see docs/todos/disappearing-dms.md).
 *
 * Timestamp strategy (deterministic, no jitter): `expiresAt = rumor.created_at
 * + durationSeconds`. The gift wrap's own `created_at` is NIP-59-randomized
 * (up to 48h past), so a "7 day" timer honestly lands in ~5–7 days.
 */

export const DISAPPEARING_OFF = 0;
/** Sentinel meaning "user has not yet accepted or declined". Always falsy in persistence. */
export const DISAPPEARING_UNDECIDED: number | undefined = undefined;

export interface DisappearingPreset {
  /** Duration in seconds. 0 means "off". */
  seconds: number;
  /** Compact UI label, e.g. "7 days". */
  label: string;
  /** Approximate chip label, e.g. "~7 days" (accounts for NIP-59 randomization). */
  approxLabel: string;
}

/**
 * Fixed presets for the 3-dot menu. Order matches the UI display order;
 * the "Off" entry is always first.
 */
export const DISAPPEARING_PRESETS: readonly DisappearingPreset[] = [
  { seconds: 0, label: 'Off', approxLabel: 'Off' },
  { seconds: 7 * 86_400, label: '7 days', approxLabel: '~7 days' },
  { seconds: 30 * 86_400, label: '30 days', approxLabel: '~30 days' },
  { seconds: 365 * 86_400, label: '1 year', approxLabel: '~1 year' },
] as const;

/**
 * Compute the absolute wall-clock expiry timestamp (unix seconds) for a
 * message created at `rumorCreatedAt` with a given duration in seconds.
 *
 * Use the rumor's real `created_at`, NOT the gift wrap's NIP-59-randomized
 * `created_at` and NOT `Date.now()`. Otherwise a relay-delayed wrap could
 * appear to expire before it arrived.
 */
export function computeExpiresAt(
  rumorCreatedAt: number,
  durationSeconds: number
): number {
  return rumorCreatedAt + durationSeconds;
}

/** True if the conversation setting is in the "undecided" state (not yet set). */
export function isUndecided(seconds: number | null | undefined): boolean {
  return seconds === undefined || seconds === null;
}

/** True if the conversation has explicitly disabled disappearing messages. */
export function isOff(seconds: number | null | undefined): boolean {
  return seconds === 0;
}

/** True if the conversation currently stamps outgoing messages with an expiration tag. */
export function isActive(seconds: number | null | undefined): boolean {
  return typeof seconds === 'number' && seconds > 0;
}

/**
 * Format the remaining time until expiry as a compact countdown label.
 * Examples: "45m left", "12h left", "6d left", "1y left".
 * Returns empty string if `expiresAt` is missing or already in the past.
 */
export function formatRemaining(
  expiresAt: number | undefined,
  now: number
): string {
  if (typeof expiresAt !== 'number') return '';
  const remaining = expiresAt - now;
  if (remaining <= 0) return '';

  const minutes = Math.floor(remaining / 60);
  const hours = Math.floor(remaining / 3600);
  const days = Math.floor(remaining / 86_400);
  const years = Math.floor(remaining / (365 * 86_400));

  if (years >= 1) return `${years}y left`;
  if (days >= 1) return `${days}d left`;
  if (hours >= 1) return `${hours}h left`;
  return `${Math.max(1, minutes)}m left`;
}

/**
 * Approximate chip label for a duration (e.g. "⏱ ~7 days"). Used above the
 * composer to indicate the active disappearing mode. Returns empty string
 * if the duration is not active. Custom values get a "~" prefix to signal
 * that the displayed unit is rounded, not exact.
 */
export function chipLabelForDuration(
  seconds: number | null | undefined
): string {
  if (!isActive(seconds)) return '';
  const preset = DISAPPEARING_PRESETS.find(p => p.seconds === seconds);
  if (preset) return `⏱ Disappears in ${preset.approxLabel}`;
  // Custom value — re-use labelForDuration so the chip and the menu agree.
  return `⏱ Disappears in ~${labelForDuration(seconds)}`;
}

/**
 * Resolve a human-readable label for a seconds value, for menu display.
 * Fixed presets return their canonical label; off/undecided return their
 * states; arbitrary custom values are decomposed into the largest fitting
 * unit (weeks → days → hours) so the menu shows "3 days" instead of "259200s".
 */
export function labelForDuration(seconds: number | null | undefined): string {
  if (isUndecided(seconds)) return 'Undecided';
  if (isOff(seconds)) return 'Off';
  const preset = DISAPPEARING_PRESETS.find(p => p.seconds === seconds);
  if (preset) return preset.label;
  // Custom value — decompose.
  const secs = seconds as number;
  const weeks = Math.floor(secs / (7 * 86_400));
  const days = Math.floor(secs / 86_400);
  const hours = Math.floor(secs / 3600);
  const minutes = Math.floor(secs / 60);
  if (weeks >= 1 && secs % (7 * 86_400) === 0)
    return `${weeks} week${weeks === 1 ? '' : 's'}`;
  if (days >= 1 && secs % 86_400 === 0)
    return `${days} day${days === 1 ? '' : 's'}`;
  if (hours >= 1 && secs % 3600 === 0)
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  if (minutes >= 1 && secs % 60 === 0)
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  // Fallback: non-clean number of seconds (rare).
  return `${secs}s`;
}
