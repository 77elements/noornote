/**
 * Regression tests for webCommentsIncludeViewer.
 *
 * Bug: the ProfileView new-posts poll included the viewer's own web comments
 * (kind 1111 `#k: web`), so an old self comment postdating the profile's
 * newest post surfaced as a bogus "new post from me" hint and was prepended
 * into the foreign timeline on refresh click.
 */

import { describe, it, expect } from 'vitest';
import { webCommentsIncludeViewer } from './webCommentsIncludeViewer';
import type { TimelineConfig } from '../components/timeline/TimelineConfig';

function configWithSource(kind: 'authors' | 'following'): TimelineConfig {
  return {
    source:
      kind === 'authors'
        ? { kind: 'authors', pubkeys: ['a'.repeat(64)] }
        : { kind: 'following' },
  } as TimelineConfig;
}

describe('webCommentsIncludeViewer', () => {
  it('excludes the viewer in author-scoped feeds (profile, tribes)', () => {
    expect(webCommentsIncludeViewer(configWithSource('authors'))).toBe(false);
  });

  it('includes the viewer in the following feed', () => {
    expect(webCommentsIncludeViewer(configWithSource('following'))).toBe(true);
  });

  it('defaults to include for legacy callers without a config', () => {
    expect(webCommentsIncludeViewer(undefined)).toBe(true);
  });
});
