/**
 * Tests for computeMenuPosition — location-sensitive MoveDropdown placement.
 * Regression: the menu of a trigger in the last tile of a row opened
 * left-anchored and overflowed the right viewport edge.
 */

import { describe, it, expect } from 'vitest';
import { computeMenuPosition } from './MoveDropdown';

const VW = 1000;
const VH = 800;

describe('computeMenuPosition', () => {
  it('drops down, left-anchored for a trigger with room on both sides', () => {
    const pos = computeMenuPosition(
      { left: 50, right: 90, top: 200, bottom: 230 },
      160,
      250,
      VW,
      VH
    );
    expect(pos.left).toBe(50);
    expect(pos.top).toBe(234); // rect.bottom + 4
  });

  it('flips to right-anchored near the right viewport edge (third tile)', () => {
    const pos = computeMenuPosition(
      { left: VW - 120, right: VW - 20, top: 200, bottom: 230 },
      160,
      250,
      VW,
      VH
    );
    // left + 160 would overflow (VW - 8 boundary) → right-anchored to trigger
    expect(pos.left).toBe(VW - 20 - 160);
    expect(pos.top).toBe(234);
  });

  it('never crosses the left viewport edge when flipping', () => {
    // menu wider than the space to the trigger's right edge
    const pos = computeMenuPosition(
      { left: 60, right: 70, top: 200, bottom: 230 },
      400,
      250,
      400, // narrow viewport
      VH
    );
    expect(pos.left).toBeGreaterThanOrEqual(8);
  });

  it('drops up when there is no room below', () => {
    const pos = computeMenuPosition(
      { left: 50, right: 90, top: 600, bottom: 630 },
      160,
      250,
      VW,
      VH
    );
    // spaceBelow = 170 < 250 and 600 > 250 → above the trigger
    expect(pos.top).toBe(600 - 250 - 4);
  });

  it('prefers drop-down when flipping up has no room either', () => {
    const pos = computeMenuPosition(
      { left: 50, right: 90, top: 200, bottom: 700 },
      160,
      250,
      VW,
      800
    );
    // spaceBelow = 100 < 250, but rect.top (200) < 250 → keep drop-down
    expect(pos.top).toBe(704);
  });
});
