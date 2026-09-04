// @vitest-environment jsdom
/**
 * PodcastCard — boost consolidation tests.
 *
 * A Fountain boost note folds everything into ONE podcast card:
 *  - the naked URL-hint link is removed (the card's Open button covers it),
 *  - the zap amount is folded in as a "⚡ X sats" line (basic + rich),
 *  - the rich upgrade (renderRich) preserves the zap line.
 */

import { describe, it, expect, vi } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

// The rich upgrade path fetches fountain.fm — not under test here.
vi.mock('../../../helpers/fountainMeta', () => ({
  isFountainUrl: () => false,
  fetchFountainMeta: vi.fn(),
}));

import {
  renderPodcastCard,
  renderRich,
  setPodcastCardZapSats,
  formatZapSatsLine,
  removePodcastUrlLinks,
  suppressPodcastUrlLinks,
} from './PodcastCard';

const EPISODE_URL = 'https://fountain.fm/episode/AzW68Sb0vFHnlhru9z3Z';

function boostEvent(): NostrEvent {
  return {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    created_at: 1788551145,
    kind: 1,
    tags: [
      ['k', 'podcast:item:guid'],
      [
        'i',
        'podcast:item:guid:c358cb22-cea9-4a92-bd32-4e55b93b5eec',
        EPISODE_URL,
      ],
    ],
    content: `Boost message\n\n${EPISODE_URL}\\nnostr:nevent1…`,
    sig: 'c'.repeat(128),
  } as unknown as NostrEvent;
}

describe('PodcastCard — boost consolidation', () => {
  it('renders the basic card from NIP-73 tags', () => {
    const card = renderPodcastCard(boostEvent());
    expect(card).not.toBeNull();
    expect(card!.className).toBe('podcast-card');
    expect(card!.querySelector('.podcast-card__kicker')?.textContent).toBe(
      'Podcast Episode'
    );
    expect(card!.querySelector('a.btn--mini')?.getAttribute('href')).toBe(
      EPISODE_URL
    );
  });

  it('folds the zap amount into the basic card as a zap line', () => {
    const card = renderPodcastCard(boostEvent())!;
    expect(card.querySelector('.podcast-card__zap')).toBeNull();
    setPodcastCardZapSats(card, 2100);
    const line = card.querySelector('.podcast-card__zap');
    expect(line?.textContent).toBe(formatZapSatsLine(2100));
    expect(line?.textContent).toMatch(/^⚡ [\d.,]+ sats$/);
  });

  it('keeps the zap line through the rich upgrade and inserts it before the actions', () => {
    const card = renderPodcastCard(boostEvent())!;
    setPodcastCardZapSats(card, 500);
    renderRich(card, EPISODE_URL, true, {
      title: 'Episode 110',
      image: 'https://example.com/cover.jpg',
      audio: 'https://example.com/audio.mp3',
      show: 'The Show',
    });
    expect(card.className).toBe('nn-card podcast-card--rich');
    const content = card.querySelector('.nn-card__content')!;
    const zap = content.querySelector('.podcast-card__zap');
    expect(zap?.textContent).toBe(formatZapSatsLine(500));
    // Zap line sits before the actions row (insertBefore), not after it.
    const zapPos = Array.from(content.children).indexOf(zap!);
    const actionsPos = Array.from(content.children).indexOf(
      content.querySelector('.podcast-card__actions')!
    );
    expect(zapPos).toBeLessThan(actionsPos);
    // Late amount update after the rich upgrade re-renders the same line.
    setPodcastCardZapSats(card, 900);
    expect(content.querySelector('.podcast-card__zap')?.textContent).toBe(
      formatZapSatsLine(900)
    );
  });

  it('removes only anchors exactly matching the URL hint and collapses emptied blocks', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <div class="event-content">
        <p>Boost message</p>
        <p><a href="${EPISODE_URL}">${EPISODE_URL}</a></p>
        <p>Other link: <a href="https://fountain.fm/show/other">show</a></p>
      </div>
    `;
    const removed = removePodcastUrlLinks(root, EPISODE_URL);
    expect(removed).toBe(1);
    expect(root.querySelectorAll('a')).toHaveLength(1);
    expect(root.querySelector('a')?.getAttribute('href')).toBe(
      'https://fountain.fm/show/other'
    );
    // The emptied <p> was collapsed, the others stay.
    expect(root.querySelectorAll('p')).toHaveLength(2);
    expect(root.textContent).toContain('Boost message');
  });

  it('suppressPodcastUrlLinks uses the event tags and .event-content scope', () => {
    const note = document.createElement('div');
    note.innerHTML = `
      <div class="event-content"><p><a href="${EPISODE_URL}">link</a></p></div>
      <footer><a href="${EPISODE_URL}">footer copy</a></footer>
    `;
    suppressPodcastUrlLinks(note, boostEvent());
    expect(note.querySelector('.event-content a')).toBeNull();
    // Links outside .event-content (e.g. footer copies) are untouched.
    expect(note.querySelector('footer a')?.getAttribute('href')).toBe(
      EPISODE_URL
    );
  });

  it('ignores non-positive zap amounts', () => {
    const card = renderPodcastCard(boostEvent())!;
    setPodcastCardZapSats(card, 0);
    setPodcastCardZapSats(card, Number.NaN);
    expect(card.querySelector('.podcast-card__zap')).toBeNull();
  });
});
