/**
 * SNO — Simple Nostr Objects parser (DECK-0003 §1.9, kind 33331).
 *
 * Community draft spec ("DECK-0003") from the Cyberspace project; the sender
 * tool is snocrash.art. Written against the deck and checked against the
 * reference implementations: `SnoParser.kt` in Quartz (Amethyst's event
 * library) and `sno-core` (MIT, TypeScript).
 *
 * §1.9 is enforced in full and in order: a payload failing any rule is refused
 * whole — "a partially valid object is not rendered partially". Counts are
 * checked against the arrays themselves; buffers are sized from those counts,
 * never from a number the payload supplies (§6 — the format has no length
 * fields for exactly this reason).
 *
 * Deliberately out of scope (spec-permitted for non-supporting readers):
 * `refs`/`parts` placements are ignored, not rejected — a reader that does not
 * support parts draws the parent's own geometry and MUST NOT reject it (§1.10).
 */

import { SNO_BUILT_IN_PALETTE, SNO_BUILT_IN_PALETTE_NAME } from './snoPalette';

export type SnoMode = 'solid' | 'points' | 'lines';

export type SnoRgb = [number, number, number];

export interface SnoObject {
  version: 1 | 2;
  name: string;
  /** Model unit of the payload (§1.2), 0..84. */
  unit: number;
  /** Grid half-width in model units, repaired to hold every vertex (§1.8). */
  extent: number;
  mode: SnoMode;
  /** Vertex positions in ticks (1/120 model unit), flat [x,y,z,...]. A v1 payload's +Z-away-from-viewer frame is already flipped on read (§2). */
  positions: Float64Array;
  /** Resolved vertex colours, parallel to positions. */
  colors: SnoRgb[];
  /** Face vertex indices, flat [a,b,c,...]. */
  faces: Int32Array;
  /** Per-face colour override, when `facecolors` is present. */
  faceColors: SnoRgb[] | null;
  up: boolean;
  /** Compass bearing 0..359; only meaningful when `up` is true (§1.7). */
  spin: number;
}

export interface SnoInvalid {
  valid: false;
  /** DECK-0003 §1.9 rule that failed, so a client can say why (§3.1). */
  rule: string;
  reason: string;
}

export type SnoParseResult = { valid: true; object: SnoObject } | SnoInvalid;

const TICKS_PER_UNIT = 120;
const MIN_EXTENT = 1;
const MAX_EXTENT = 64;
const DEFAULT_EXTENT = 8;
const MAX_UNIT = 84;
const MAX_NAME = 64;
/** Palette bounds (§1.3a): an inline palette carries 2..256 entries. */
const MIN_PALETTE_ENTRIES = 2;
const MAX_PALETTE_ENTRIES = 256;

function isPlainInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isPlainArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** Grid half-width that holds every vertex, rounded away from zero (§1.8). */
function grownExtent(declared: number, positions: Float64Array): number {
  let needed = declared;
  for (let i = 0; i < positions.length; i++) {
    const units = Math.ceil(Math.abs(positions[i]!) / TICKS_PER_UNIT);
    if (units > needed) needed = units;
  }
  return needed;
}

/**
 * Sub-unit part of every position, run-length decoded (§1.2). An entry is
 * either a `[dx,dy,dz]` triple for one vertex or a negative integer `-N` for N
 * consecutive vertices whose remainder is `[0,0,0]`. Absent → every position
 * is whole. Returns null when entries do not expand to one remainder per vertex.
 */
function expandTicks(field: unknown, vertexCount: number): number[] | null {
  const out = new Array<number>(vertexCount * 3).fill(0);
  if (field === undefined || field === null) return out;

  if (!isPlainArray(field)) return null;
  let written = 0;
  for (const entry of field) {
    if (isPlainArray(entry)) {
      if (entry.length !== 3 || written >= vertexCount) return null;
      for (let axis = 0; axis < 3; axis++) {
        const v = entry[axis];
        if (!isPlainInt(v) || v < 0 || v >= TICKS_PER_UNIT) return null;
        out[written * 3 + axis] = v;
      }
      written++;
    } else if (isPlainInt(entry)) {
      // Bounded before it is negated: a run longer than the vertex list is
      // invalid anyway, so one test does both.
      if (entry >= 0 || entry < -vertexCount) return null;
      written += -entry;
    } else {
      return null;
    }
  }
  return written === vertexCount ? out : null;
}

/**
 * One palette index per face, run-length decoded (§1.4a): a non-negative
 * index, or a negative integer `-N` for N further faces of the index before
 * it. The first entry must be an index — a run has nothing to repeat.
 */
function expandFaceColors(
  field: unknown,
  faceCount: number,
  paletteSize: number
): number[] | null {
  if (!isPlainArray(field)) return null;
  const out: number[] = [];
  let previous = -1;
  for (const entry of field) {
    if (!isPlainInt(entry)) return null;
    if (entry < 0) {
      if (
        previous < 0 ||
        entry < -faceCount ||
        out.length + -entry > faceCount
      ) {
        return null;
      }
      const count = -entry;
      for (let i = 0; i < count; i++) out.push(previous);
    } else {
      if (entry >= paletteSize || out.length >= faceCount) return null;
      out.push(entry);
      previous = entry;
    }
  }
  return out.length === faceCount ? out : null;
}

/** Literal `[r,g,b]` of 0..1 numbers, clamped on read, taken as written (§1.3). */
function readLiteralTriple(triple: unknown): SnoRgb | null {
  if (!isPlainArray(triple) || triple.length !== 3) return null;
  const out: SnoRgb = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const raw = triple[i];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
    out[i] = Math.round(Math.min(1, Math.max(0, raw)) * 255);
  }
  return out;
}

/**
 * §1.3a with rule 8a's shapes: absent → built-in; the built-in's name →
 * built-in; a well-formed nevent/naddr → built-in (a reader MUST render
 * without waiting for anything, §1.3b — fetching palettes is a future
 * improvement); an array of 2..256 RGB triples → inline. Anything else
 * refuses the payload.
 */
function readInlinePalette(
  field: unknown
): { size: number; get: (index: number) => SnoRgb } | null {
  if (field === undefined || field === null) return builtInPalette();
  if (typeof field === 'string') {
    if (field === SNO_BUILT_IN_PALETTE_NAME) return builtInPalette();
    // Unresolved event references count as the built-in, never a rejection.
    return field.startsWith('nevent1') || field.startsWith('naddr1')
      ? builtInPalette()
      : null;
  }
  if (!isPlainArray(field)) return null;
  if (
    field.length < MIN_PALETTE_ENTRIES ||
    field.length > MAX_PALETTE_ENTRIES
  ) {
    return null;
  }
  const colors: SnoRgb[] = [];
  for (const entry of field) {
    if (!isPlainArray(entry) || entry.length !== 3) return null;
    const r = entry[0];
    const g = entry[1];
    const b = entry[2];
    if (!isPlainInt(r) || !isPlainInt(g) || !isPlainInt(b)) return null;
    if (r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255) return null;
    colors.push([r, g, b]);
  }
  return {
    size: colors.length,
    // Indices are bounds-checked by every caller before the lookup.
    get: i => colors[i]!,
  };
}

function builtInPalette(): { size: number; get: (index: number) => SnoRgb } {
  return {
    size: SNO_BUILT_IN_PALETTE.length,
    // Indices are bounds-checked by every caller before the lookup.
    get: i => SNO_BUILT_IN_PALETTE[i]!,
  };
}

/** Rule 8b: v1 literal triples; v2 palette indices — literals also accepted. */
function readColor(
  field: unknown,
  version: 1 | 2,
  palette: { size: number; get: (index: number) => SnoRgb }
): SnoRgb | null {
  if (isPlainArray(field)) return readLiteralTriple(field);
  // An index is version 2's form, and version 1 never had one.
  if (version === 1) return null;
  if (!isPlainInt(field) || field < 0 || field >= palette.size) return null;
  return palette.get(field);
}

/**
 * Parses an event's `content` into a renderable object. Returns a refusal
 * naming the failed §1.9 rule — never a partial object.
 */
export function parseSno(content: string): SnoParseResult {
  let root: unknown;
  try {
    root = JSON.parse(content);
  } catch {
    return {
      valid: false,
      rule: 'json',
      reason: 'content is not a JSON object',
    };
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    return {
      valid: false,
      rule: 'json',
      reason: 'content is not a JSON object',
    };
  }
  const obj = root as Record<string, unknown>;

  // Rule 1. `type`, if present, is ignored and never rejected on (§1.1a).
  const version = obj.v;
  if (version !== 1 && version !== 2) {
    return { valid: false, rule: '1', reason: 'v is not 1 or 2' };
  }

  // Rule 2. The three required arrays, vertices parallel to colors.
  const vertices = obj.vertices;
  const colors = obj.colors;
  const faces = obj.faces;
  if (!isPlainArray(vertices)) {
    return { valid: false, rule: '2', reason: 'vertices is not an array' };
  }
  if (!isPlainArray(colors)) {
    return { valid: false, rule: '2', reason: 'colors is not an array' };
  }
  if (!isPlainArray(faces)) {
    return { valid: false, rule: '2', reason: 'faces is not an array' };
  }
  if (vertices.length !== colors.length) {
    return {
      valid: false,
      rule: '2',
      reason: 'vertices and colors differ in length',
    };
  }

  // Rule 3 sets no bound: a reader MUST NOT reject a payload for its vertex
  // or face count (§1.8). The relay's size limit bounds the payload instead.

  // Rule 4.
  const mode = obj.mode;
  if (mode !== 'solid' && mode !== 'points' && mode !== 'lines') {
    return {
      valid: false,
      rule: '4',
      reason: 'mode is not solid, points or lines',
    };
  }

  // Rule 5.
  if (!isPlainInt(obj.unit) || obj.unit < 0 || obj.unit > MAX_UNIT) {
    return {
      valid: false,
      rule: '5',
      reason: `unit is outside 0..${MAX_UNIT}`,
    };
  }
  const unit: number = obj.unit;

  // Rule 7, before rule 6: a position needs both halves to exist.
  const ticks = expandTicks(obj.ticks, vertices.length);
  if (ticks === null) {
    return {
      valid: false,
      rule: '7',
      reason: 'ticks do not expand to one remainder per vertex',
    };
  }

  // Rule 6. Whole parts plus tick remainders; v1 has +Z away from the viewer,
  // so its Z is negated on read (§2); v2 is read as written.
  const positions = new Float64Array(vertices.length * 3);
  for (let i = 0; i < vertices.length; i++) {
    const triple = vertices[i];
    if (!isPlainArray(triple) || triple.length !== 3) {
      return {
        valid: false,
        rule: '6',
        reason: `vertex ${i} is not three integers`,
      };
    }
    for (let axis = 0; axis < 3; axis++) {
      const whole = triple[axis];
      if (!isPlainInt(whole)) {
        return {
          valid: false,
          rule: '6',
          reason: `vertex ${i} is not three integers`,
        };
      }
      const total = whole * TICKS_PER_UNIT + ticks[i * 3 + axis]!;
      if (!Number.isSafeInteger(total)) {
        return {
          valid: false,
          rule: 'bound',
          reason: 'vertex lies past what the lattice can hold exactly',
        };
      }
      positions[i * 3 + axis] = axis === 2 && version === 1 ? -total : total;
    }
  }

  // Rule 8.
  const faceIndices = new Int32Array(faces.length * 3);
  for (let i = 0; i < faces.length; i++) {
    const triple = faces[i];
    if (!isPlainArray(triple) || triple.length !== 3) {
      return {
        valid: false,
        rule: '8',
        reason: `face ${i} is not three indices`,
      };
    }
    const a = triple[0];
    const b = triple[1];
    const c = triple[2];
    if (!isPlainInt(a) || !isPlainInt(b) || !isPlainInt(c)) {
      return {
        valid: false,
        rule: '8',
        reason: `face ${i} has a non-integer index`,
      };
    }
    if (
      a < 0 ||
      a >= vertices.length ||
      b < 0 ||
      b >= vertices.length ||
      c < 0 ||
      c >= vertices.length
    ) {
      return {
        valid: false,
        rule: '8',
        reason: `face ${i} points at a vertex that does not exist`,
      };
    }
    if (a === b || b === c || a === c) {
      return {
        valid: false,
        rule: '8',
        reason: `face ${i} does not have three distinct vertices`,
      };
    }
    faceIndices[i * 3] = a;
    faceIndices[i * 3 + 1] = b;
    faceIndices[i * 3 + 2] = c;
  }

  // Rule 8a.
  const palette = readInlinePalette(obj.palette);
  if (palette === null) {
    return {
      valid: false,
      rule: '8a',
      reason:
        'palette is not a known name, a well-formed nevent/naddr, or 2..256 RGB entries',
    };
  }

  // Rule 8b.
  const vertexColors: SnoRgb[] = new Array<SnoRgb>(colors.length);
  for (let i = 0; i < colors.length; i++) {
    const color = readColor(colors[i], version, palette);
    if (color === null) {
      return {
        valid: false,
        rule: '8b',
        reason: `colors[${i}] is not a valid colour for a v${version} payload`,
      };
    }
    vertexColors[i] = color;
  }

  // Rule 8c.
  let faceColors: SnoRgb[] | null = null;
  if (obj.facecolors !== undefined) {
    const expanded = expandFaceColors(
      obj.facecolors,
      faces.length,
      palette.size
    );
    if (expanded === null) {
      return {
        valid: false,
        rule: '8c',
        reason: 'facecolors do not expand to one valid index per face',
      };
    }
    faceColors = expanded.map(index => palette.get(index)!);
  }

  // Rule 10. Validated whether or not `up` is present: a payload carrying a
  // nonsense bearing is malformed even where the bearing is unused (§1.7).
  const upField = obj.up;
  if (upField !== undefined && typeof upField !== 'boolean') {
    return { valid: false, rule: '10', reason: 'up is not a boolean' };
  }
  const up = upField === true;
  const spinField = obj.spin;
  if (spinField !== undefined) {
    if (!isPlainInt(spinField) || spinField < 0 || spinField > 359) {
      return {
        valid: false,
        rule: '10',
        reason: 'spin is not an integer in 0..359',
      };
    }
  }

  // Rule 9. `extent` is repaired rather than validated: out of range becomes
  // the default, then it grows to contain the data. The data wins.
  const declared = obj.extent;
  const repaired =
    isPlainInt(declared) && declared >= MIN_EXTENT && declared <= MAX_EXTENT
      ? declared
      : DEFAULT_EXTENT;
  const extent = grownExtent(repaired, positions);

  const nameField = obj.name;
  const name =
    typeof nameField === 'string' ? nameField.slice(0, MAX_NAME) : '';

  return {
    valid: true,
    object: {
      version,
      name,
      unit,
      extent,
      mode,
      positions,
      colors: vertexColors,
      faces: faceIndices,
      faceColors,
      up,
      spin: up && isPlainInt(spinField) ? spinField : 0,
    },
  };
}
