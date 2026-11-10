// @vitest-environment jsdom
/**
 * Regression tests for Communikeys community definition processing and
 * rendering (kind 32222). These events previously fell into the
 * "Unsupported event kind" fallback when opened via naddr (e.g. the
 * budabit.club calendar link); they must route to
 * CommunityDefinitionProcessor and render a self-contained community card
 * (name/description/picture/website/relays live in the event's own tags).
 */

import { describe, it, expect, vi } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

// The real ContentProcessor pulls in the lists/AutoSync chain (PlatformService,
// SystemLogger singletons) which cannot load in the node test environment.
vi.mock('../../../services/ContentProcessor', async () => {
  const { contentProcessorMock } = await import('./noteProcessorTestMocks');
  return contentProcessorMock;
});

vi.mock('../note-rendering/NoteStructureBuilder', () => ({
  NoteStructureBuilder: {
    build: () => {
      const element = document.createElement('div');
      const body = document.createElement('div');
      body.className = 'event-content';
      element.appendChild(body);
      return { element };
    },
  },
}));

// The real UserMentionHelper imports UserHoverCard → lists/follows chain,
// which cannot load in the test environment. Stub it with the same markup
// shape (mention chip: link + mini avatar + mention-name).
vi.mock('../../../helpers/UserMentionHelper', () => ({
  renderUserMention: (
    pubkey: string,
    profile: { username: string; avatarUrl?: string }
  ) =>
    `<a class="mention-link mention-link--bg" data-profile-pubkey="${pubkey}"><img class="profile-pic profile-pic--mini" src="${profile.avatarUrl ?? ''}" width="18" height="18" loading="lazy" decoding="async" /><span class="mention-name">${profile.username}</span></a>`,
  setupUserMentionHandlers: vi.fn(),
}));

let cachedProfile: Record<string, string> | null = null;
let lastRelayHints: string[] | undefined;

vi.mock('../../../services/UserProfileService', () => ({
  UserProfileService: {
    getInstance: () => ({
      getCachedProfile: (pubkey: string) =>
        pubkey === PUBKEY ? cachedProfile : null,
      getUserProfile: (pubkey: string, relayHints?: string[]) => {
        lastRelayHints = relayHints;
        return Promise.resolve().then(() =>
          pubkey === PUBKEY ? cachedProfile : null
        );
      },
    }),
  },
}));

import { CommunityDefinitionProcessor } from './CommunityDefinitionProcessor';
import { CommunityDefinitionRenderer } from '../note-rendering/CommunityDefinitionRenderer';
import { NoteProcessor } from './NoteProcessor';
import type { NoteUIOptions } from '../types/NoteTypes';

const PUBKEY = 'b'.repeat(64);

function communityEvent(
  tags: string[][] = [
    ['d', '0a8ecba4868c13e1e84cc5cb58c02c1fd0880d9e5a25a5050ee96ad8a166d7c8'],
    ['name', 'BudaBit'],
    ['description', 'Builders in Freedom Tech'],
    ['picture', 'https://example.com/picture.png'],
    ['website', 'https://budabit.org'],
    ['r', 'wss://relay.budabit.club'],
    ['alt', 'BudaBit community definition'],
  ]
): NostrEvent {
  return {
    id: 'c'.repeat(64),
    kind: 32222,
    pubkey: PUBKEY,
    created_at: 1_793_168_863,
    content: '',
    tags,
    sig: 'd'.repeat(128),
  } as unknown as NostrEvent;
}

const OPTS = { collapsible: false, depth: 0 } as unknown as NoteUIOptions;

describe('CommunityDefinitionProcessor', () => {
  it('routes kind 32222 to community-definition', () => {
    const note = CommunityDefinitionProcessor.process(communityEvent());

    expect(note.type).toBe('community-definition');
    expect(note.author.pubkey).toBe(PUBKEY);
    expect(note.content.text).toBe('');
  });

  it('is reachable through the central NoteProcessor dispatch', () => {
    const note = NoteProcessor.process(communityEvent());
    expect(note.type).toBe('community-definition');
  });
});

describe('CommunityDefinitionRenderer', () => {
  it('renders name, description, website and relays from tags', () => {
    const note = CommunityDefinitionProcessor.process(communityEvent());
    const el = CommunityDefinitionRenderer.render(note, OPTS);

    const text = el.querySelector('.event-content')?.textContent ?? '';
    expect(text).toContain('BudaBit');
    expect(text).toContain('Builders in Freedom Tech');
    expect(text).toContain('budabit.org');
    expect(text).toContain('relay.budabit.club');

    const img = el.querySelector('img');
    expect(img?.getAttribute('src')).toBe('https://example.com/picture.png');
  });

  it('renders an inline card for quote/naddr previews', () => {
    const card = CommunityDefinitionRenderer.renderInlineCard(communityEvent());

    expect(card.className).toBe('community-card');
    expect(card.textContent).toContain('BudaBit');
  });

  it('falls back to an emoji thumb when no picture tag exists', () => {
    const event = communityEvent([
      ['d', 'x'],
      ['name', 'No Picture'],
    ]);
    const card = CommunityDefinitionRenderer.renderInlineCard(event);

    expect(card.querySelector('img')).toBeNull();
    expect(card.querySelector('.community-card__thumb--emoji')).not.toBeNull();
  });

  it('renders the owner as a real mention chip when the profile is cached', () => {
    cachedProfile = {
      name: 'BudaBit Owner',
      picture: 'https://example.com/owner.jpg',
    };
    const card = CommunityDefinitionRenderer.renderInlineCard(communityEvent());
    const owner = card.querySelector('.community-card__owner');

    expect(owner?.querySelector('a.mention-link')).not.toBeNull();
    expect(owner?.querySelector('.mention-name')?.textContent).toBe(
      'BudaBit Owner'
    );
    expect(owner?.querySelector('img.profile-pic--mini')).not.toBeNull();
    // User display rule: never show npub/HEX in the owner line.
    expect(owner?.textContent).not.toContain('npub1');
    expect(owner?.textContent).not.toContain(PUBKEY);
  });

  it('leaves the owner line empty until the profile resolves (never shows npub)', async () => {
    cachedProfile = null;
    const card = CommunityDefinitionRenderer.renderInlineCard(communityEvent());
    const owner = card.querySelector('.community-card__owner');
    expect(owner?.textContent?.trim()).toBe('');

    // Async patch once getUserProfile resolves with a profile.
    cachedProfile = { name: 'Late Owner' };
    await vi.waitFor(() => {
      expect(owner?.querySelector('.mention-name')?.textContent).toBe(
        'Late Owner'
      );
    });
    expect(owner?.textContent).not.toContain('npub1');
    // The community's own r-tag relays are passed as relay hints so the
    // owner's kind:0 is found on the community relay (e.g. budabit).
    expect(lastRelayHints).toContain('wss://relay.budabit.club');
  });
});
