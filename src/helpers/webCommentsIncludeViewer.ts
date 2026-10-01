/**
 * Whether web-comment (kind 1111, `#k: web`) queries for a timeline should
 * include the viewer's OWN comments.
 *
 * - Following feed ('following'): yes — the viewer's own posts belong in
 *   their home timeline even if they don't follow themselves.
 * - Author-scoped feeds ('authors' — ProfileView, tribes): NO. The viewer's
 *   comments must never leak into someone else's timeline — they otherwise
 *   surface as bogus "new post from me" refresh hints and get prepended
 *   into the foreign timeline (old comments postdating the profile's last
 *   post match the poll window `since newest-post .. now`).
 * - No config (legacy callers, e.g. FollowPackManager): true — preserves the
 *   pre-fix behavior.
 */

import type { TimelineConfig } from '../components/timeline/TimelineConfig';

export function webCommentsIncludeViewer(config?: TimelineConfig): boolean {
  return config?.source.kind !== 'authors';
}
