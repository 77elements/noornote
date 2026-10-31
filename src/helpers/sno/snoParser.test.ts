/**
 * SNO parser regression tests (DECK-0003 §1.9).
 *
 * The valid-payload fixtures mirror the format the snocrash.art workshop
 * publishes (kind 33331: inline vertices on an integer lattice with 120ths
 * ticks, palette indices for v2, literal 0..1 RGB triples for v1).
 */

import { describe, expect, it } from 'vitest';
import { parseSno } from './snoParser';

/** Minimal valid v2 object: one triangle, solid, built-in palette. */
const V2_SOLID = {
  v: 2,
  name: 'tri',
  unit: 0,
  extent: 4,
  mode: 'solid',
  vertices: [
    [-1, 0, 0],
    [1, 0, 0],
    [0, 2, 0],
  ],
  colors: [0, 1, 2],
  faces: [[0, 1, 2]],
};

describe('SnoParser — valid payloads', () => {
  it('parses a v2 solid object and resolves palette colours', () => {
    const result = parseSno(JSON.stringify(V2_SOLID));
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.object.mode).toBe('solid');
    expect(result.object.version).toBe(2);
    expect(Array.from(result.object.positions)).toEqual([
      -120, 0, 0, 120, 0, 0, 0, 240, 0,
    ]);
    // Vertex 0 → built-in palette index 0 = rgb(0, 54, 50)
    expect(result.object.colors[0]).toEqual([0, 54, 50]);
    expect(Array.from(result.object.faces)).toEqual([0, 1, 2]);
    expect(result.object.name).toBe('tri');
  });

  it('negates the z axis of a v1 payload (§2 frame flip) and reads literal colours', () => {
    const v1 = {
      v: 1,
      mode: 'points',
      unit: 0,
      extent: 1,
      vertices: [[0, 0, 1]],
      colors: [[0.5, 0.5, 0.5]],
      faces: [],
    };
    const result = parseSno(JSON.stringify(v1));
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(Array.from(result.object.positions)).toEqual([0, 0, -120]);
    expect(result.object.colors[0]).toEqual([128, 128, 128]);
  });

  it('accepts literal rgb triples in v2 payloads (orphaned work, §5)', () => {
    const v2Literal = {
      ...V2_SOLID,
      colors: [
        [0, 0, 1],
        [0, 1, 0],
        [1, 0, 0],
      ],
    };
    const result = parseSno(JSON.stringify(v2Literal));
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.object.colors[0]).toEqual([0, 0, 255]);
  });

  it('expands run-length ticks: -N means N whole vertices', () => {
    const withTicks = {
      ...V2_SOLID,
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
        [3, 0, 0],
      ],
      colors: [0, 0, 0, 0],
      faces: [],
      ticks: [[0, 0, 1], [0, 0, 2], [0, 0, 3], -1],
    };
    const result = parseSno(JSON.stringify(withTicks));
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(Array.from(result.object.positions)).toEqual([
      0, 0, 1, 120, 0, 2, 240, 0, 3, 360, 0, 0,
    ]);
  });

  it('repairs a declared extent that is too small to hold the vertices (§1.8)', () => {
    const tight = { ...V2_SOLID, extent: 1 };
    const result = parseSno(JSON.stringify(tight));
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.object.extent).toBe(2); // vertex y=2 needs half-width 2
  });

  it('resolves an inline palette and validates its shape', () => {
    const inline = {
      ...V2_SOLID,
      colors: [0, 1, 1],
      palette: [
        [10, 20, 30],
        [255, 0, 0],
      ],
    };
    const result = parseSno(JSON.stringify(inline));
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.object.colors[0]).toEqual([10, 20, 30]);
    expect(result.object.colors[1]).toEqual([255, 0, 0]);
  });

  it('ignores refs/parts placements (non-supporting reader, §1.10)', () => {
    const withParts = { ...V2_SOLID, parts: [{ ref: 'naddr1qq' }], refs: [] };
    const result = parseSno(JSON.stringify(withParts));
    expect(result.valid).toBe(true);
  });

  it('resolves unknown palette names and event references to the built-in (§1.3b)', () => {
    const neventPalette = { ...V2_SOLID, palette: 'nevent1qqst8' };
    expect(parseSno(JSON.stringify(neventPalette)).valid).toBe(true);
    const namedPalette = { ...V2_SOLID, palette: 'cyberspace-neon-256' };
    expect(parseSno(JSON.stringify(namedPalette)).valid).toBe(true);
  });
});

describe('SnoParser — rejections (§1.9, refuse whole)', () => {
  const rejected = (content: string, rule: string) => {
    const result = parseSno(content);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.rule).toBe(rule);
  };

  it('rejects non-JSON and non-object content', () => {
    rejected('not json', 'json');
    rejected('[1,2,3]', 'json');
  });

  it('rejects a version that is not 1 or 2 (rule 1)', () => {
    rejected(JSON.stringify({ ...V2_SOLID, v: 3 }), '1');
    rejected(JSON.stringify({ ...V2_SOLID, v: '2' }), '1');
  });

  it('rejects missing or mismatched required arrays (rule 2)', () => {
    rejected(JSON.stringify({ ...V2_SOLID, vertices: undefined }), '2');
    rejected(JSON.stringify({ ...V2_SOLID, colors: [0, 1] }), '2');
    rejected(JSON.stringify({ ...V2_SOLID, faces: 'nope' }), '2');
  });

  it('rejects an unknown mode (rule 4)', () => {
    rejected(JSON.stringify({ ...V2_SOLID, mode: 'wireframe' }), '4');
  });

  it('rejects a unit outside 0..84 (rule 5)', () => {
    rejected(JSON.stringify({ ...V2_SOLID, unit: 85 }), '5');
    rejected(JSON.stringify({ ...V2_SOLID, unit: -1 }), '5');
  });

  it('rejects ticks that do not expand to one remainder per vertex (rule 7)', () => {
    rejected(JSON.stringify({ ...V2_SOLID, ticks: [-5] }), '7');
    rejected(JSON.stringify({ ...V2_SOLID, ticks: [0] }), '7');
    rejected(JSON.stringify({ ...V2_SOLID, ticks: [[0, 0]] }), '7');
    rejected(JSON.stringify({ ...V2_SOLID, ticks: [[0, 0, 120]] }), '7');
  });

  it('rejects malformed vertices (rule 6)', () => {
    rejected(
      JSON.stringify({
        ...V2_SOLID,
        vertices: [
          [0, 0],
          [1, 0, 0],
          [0, 1, 0],
        ],
      }),
      '6'
    );
    rejected(
      JSON.stringify({
        ...V2_SOLID,
        vertices: [
          [0, 0, 'x'],
          [1, 0, 0],
          [0, 1, 0],
        ],
      }),
      '6'
    );
  });

  it('rejects faces with out-of-range or duplicate indices (rule 8)', () => {
    rejected(JSON.stringify({ ...V2_SOLID, faces: [[0, 1, 3]] }), '8');
    rejected(JSON.stringify({ ...V2_SOLID, faces: [[0, 0, 1]] }), '8');
    rejected(JSON.stringify({ ...V2_SOLID, faces: [[0, 1, 1]] }), '8');
  });

  it('rejects a palette that is neither a known name, a reference, nor RGB entries (rule 8a)', () => {
    rejected(JSON.stringify({ ...V2_SOLID, palette: 'hot-pink' }), '8a');
    rejected(JSON.stringify({ ...V2_SOLID, palette: [[[0, 0, 0]]] }), '8a');
    rejected(JSON.stringify({ ...V2_SOLID, palette: [[0, 0, 300]] }), '8a');
  });

  it('rejects v2 colour indices outside the palette (rule 8b)', () => {
    rejected(JSON.stringify({ ...V2_SOLID, colors: [999, 0, 0] }), '8b');
    rejected(JSON.stringify({ ...V2_SOLID, colors: ['0', '1', '2'] }), '8b');
  });

  it('rejects malformed facecolors (rule 8c)', () => {
    rejected(JSON.stringify({ ...V2_SOLID, facecolors: [-1] }), '8c');
    rejected(JSON.stringify({ ...V2_SOLID, facecolors: [0, -5] }), '8c');
    rejected(JSON.stringify({ ...V2_SOLID, facecolors: [777] }), '8c');
  });

  it('rejects a non-boolean up and a spin outside 0..359, even when unused (rule 10)', () => {
    rejected(JSON.stringify({ ...V2_SOLID, up: 'yes' }), '10');
    rejected(JSON.stringify({ ...V2_SOLID, up: true, spin: 400 }), '10');
    rejected(JSON.stringify({ ...V2_SOLID, spin: 12.5 }), '10');
  });

  it('zeroes spin when up is absent or false (§1.7: bearing is unused)', () => {
    const result = parseSno(JSON.stringify({ ...V2_SOLID, spin: 90 }));
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.object.spin).toBe(0);
  });
});
