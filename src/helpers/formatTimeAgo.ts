/**
 * Format a timestamp as relative time (e.g., "5s ago", "3m ago", "2h ago", "1d ago")
 *
 * Locale-aware: unit letters ("d", "h", "m", "s") and "Just now" are translated
 * via i18n so each language renders its own compact form (de: "5s", "3min",
 * "2Std.", "1T." + "Gerade eben").
 */
import { _ } from '../i18n';

export function formatTimeAgo(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return _('%s d ago', days);
  if (hours > 0) return _('%s h ago', hours);
  if (minutes > 0) return _('%s m ago', minutes);
  if (seconds > 0) return _('%s s ago', seconds);
  return _('Just now');
}
