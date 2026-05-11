/**
 * Divider effect: a `clip-path` cut on the block wrapper's top / bottom
 * edge. Whatever sits behind shows through — no color picker needed.
 *
 * Two consumers:
 *   - `styleWrap` calls `buildClipPath` to compose the actual CSS clip
 *     for the wrapper's inline style.
 *   - The Properties panel uses `DIVIDER_STYLE_OPTIONS` + `dividerThumbSvg`
 *     to render the picker.
 */

import type { CommonStyle, DividerStyle } from './types';

export interface DividerStyleDef {
  /** UI label shown in the picker. */
  name: string;
  /** Vertical extent of the cut. Per-style because a wave needs more
   *  headroom than a slant; user has no override (= keep config minimal). */
  height: string;
  /** Sample points along the cut edge in band coords, ordered LEFT→RIGHT.
   *  x ∈ [0, 100], y ∈ [0, 10] where y=0 is the inner peak (deepest into
   *  the wrapper) and y=10 is the wrapper's outer edge.
   *  First x must be 0, last x must be 100 — the cut spans the full width.
   *  Curves are pre-sampled to polygon points so we get a single uniform
   *  pipeline (CSS `clip-path: polygon()` doesn't take Bezier directly). */
  cutPath: Array<[number, number]>;
}

/** Sample n+1 evenly-spaced points along a quadratic Bezier. Used to
 *  approximate smooth curves as polygon points. */
function sampleQuad(p0: [number, number], cp: [number, number], p1: [number, number], n: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const x = u * u * p0[0] + 2 * t * u * cp[0] + t * t * p1[0];
    const y = u * u * p0[1] + 2 * t * u * cp[1] + t * t * p1[1];
    pts.push([Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
  }
  return pts;
}

/** Catalog of available divider styles. Each entry is the cut shape; the
 *  renderer applies it as `clip-path` on the wrapper so the parent
 *  container's bottom (or top) edge is geometrically removed and whatever
 *  sits behind shows through. Adding a new shape = one entry here. */
export const DIVIDER_CATALOG: Record<Exclude<DividerStyle, 'none'>, DividerStyleDef> = {
  slant: {
    name: 'Slant',
    height: '60px',
    cutPath: [[0, 10], [100, 0]],
  },
  curve: {
    name: 'Curve',
    height: '80px',
    cutPath: sampleQuad([0, 10], [50, 0], [100, 10], 12),
  },
  'curve-asymmetric': {
    name: 'Curve Asymmetric',
    height: '80px',
    cutPath: sampleQuad([0, 10], [33, 0], [100, 10], 12),
  },
  triangle: {
    name: 'Triangle',
    height: '60px',
    cutPath: [[0, 10], [50, 0], [100, 10]],
  },
  'triangle-asymmetric': {
    name: 'Triangle Asymmetric',
    height: '60px',
    cutPath: [[0, 10], [33, 0], [100, 10]],
  },
  wave: {
    name: 'Wave',
    height: '80px',
    cutPath: [
      ...sampleQuad([0, 10], [25, 0], [50, 10], 6),
      ...sampleQuad([50, 10], [75, 0], [100, 10], 6).slice(1),
    ],
  },
  'wave-double': {
    name: 'Wave Double',
    height: '60px',
    cutPath: [
      ...sampleQuad([0, 10], [12.5, 0], [25, 10], 4),
      ...sampleQuad([25, 10], [37.5, 0], [50, 10], 4).slice(1),
      ...sampleQuad([50, 10], [62.5, 0], [75, 10], 4).slice(1),
      ...sampleQuad([75, 10], [87.5, 0], [100, 10], 4).slice(1),
    ],
  },
  mountains: {
    name: 'Mountains',
    height: '80px',
    cutPath: [[0, 10], [20, 4], [40, 7], [60, 2], [80, 6], [100, 10]],
  },
  notch: {
    name: 'Notch',
    height: '60px',
    // Rectangular indent in the middle — vertical edges at x=35 and x=65.
    cutPath: [[0, 10], [35, 10], [35, 0], [65, 0], [65, 10], [100, 10]],
  },
};

/** Resolve a divider field (the value at `style.divider.<side>`) to a
 *  catalog key, tolerating the legacy `{ style, color, height }` shape. */
function resolveDividerStyle(value: unknown): Exclude<DividerStyle, 'none'> | null {
  let s: string | null = null;
  if (typeof value === 'string') s = value;
  else if (value && typeof value === 'object' && typeof (value as { style?: unknown }).style === 'string') {
    s = (value as { style: string }).style;
  }
  if (!s || s === 'none') return null;
  return s in DIVIDER_CATALOG ? (s as Exclude<DividerStyle, 'none'>) : null;
}

/** Apply the user's flip flags to a cut path.
 *   - `flipY` (vertical = mirror at x-axis): y → 10−y. Order preserved.
 *   - `flipX` (horizontal = mirror at y-axis): x → 100−x + reverse so
 *     the result still walks left→right.
 *  Both can be combined; the operations commute. */
function transformCutPath(
  cutPath: Array<[number, number]>,
  flipX: boolean,
  flipY: boolean,
): Array<[number, number]> {
  let pts: Array<[number, number]> = cutPath;
  if (flipY) pts = pts.map(([x, y]) => [x, 10 - y]);
  if (flipX) pts = [...pts].reverse().map(([x, y]) => [100 - x, y]);
  return pts;
}

/** Build a CSS `clip-path: polygon(...)` string from the divider config.
 *  Returns null when no divider is configured. The polygon walks the
 *  wrapper's perimeter clockwise, perturbing the top edge with the top
 *  cut path (left→right) and the bottom edge with the bottom cut path
 *  (right→left). When only one side is set, the other side stays straight. */
export function buildClipPath(divider: CommonStyle['divider']): string | null {
  const topStyle = resolveDividerStyle(divider?.top);
  const bottomStyle = resolveDividerStyle(divider?.bottom);
  if (!topStyle && !bottomStyle) return null;
  const flipX = !!divider?.flipX;
  const flipY = !!divider?.flipY;

  const points: string[] = [];

  if (topStyle) {
    const def = DIVIDER_CATALOG[topStyle];
    const path = transformCutPath(def.cutPath, flipX, flipY);
    // For a TOP cut, band y=10 is the wrapper's outer top (y=0%) and y=0
    // is the inner peak (y = topHeight). Map: wrapY = topH * (10 - bandY) / 10
    for (const [x, y] of path) {
      points.push(`${x}% calc(${def.height} * ${((10 - y) / 10).toFixed(3)})`);
    }
  } else {
    points.push('0% 0%', '100% 0%');
  }

  if (bottomStyle) {
    const def = DIVIDER_CATALOG[bottomStyle];
    const path = transformCutPath(def.cutPath, flipX, flipY);
    // For a BOTTOM cut, band y=10 is the wrapper's outer bottom (y=100%)
    // and y=0 is the inner peak (y = 100% - bottomHeight).
    // Map: wrapY = calc(100% - bottomH * (10 - bandY) / 10)
    // Reverse the cut path so we walk right→left (CW perimeter).
    const reversed = [...path].reverse();
    for (const [x, y] of reversed) {
      points.push(`${x}% calc(100% - ${def.height} * ${((10 - y) / 10).toFixed(3)})`);
    }
  } else {
    points.push('100% 100%', '0% 100%');
  }

  return `polygon(${points.join(', ')})`;
}

/** UI-side metadata for the divider style picker — value + visible label.
 *  Derived from `DIVIDER_CATALOG` so adding a shape automatically adds it
 *  to the picker. `none` is hard-coded as the first option. */
export const DIVIDER_STYLE_OPTIONS: Array<{ value: DividerStyle; label: string }> = [
  { value: 'none', label: 'None' },
  ...(Object.entries(DIVIDER_CATALOG) as Array<[Exclude<DividerStyle, 'none'>, DividerStyleDef]>)
    .map(([value, def]) => ({ value: value as DividerStyle, label: def.name })),
];

/** Tiny inline SVG thumbnail for one divider style (or a flat line for
 *  'none'). Used in the dropdown trigger and in each menu option. Closes
 *  the cutPath back along the bottom edge to render the area-that-gets-cut
 *  as a filled polygon — matches the visual the user gets on the page. */
export function dividerThumbSvg(style: DividerStyle | string): string {
  if (style === 'none' || !DIVIDER_CATALOG[style as Exclude<DividerStyle, 'none'>]) {
    return `<svg viewBox="0 0 100 10" preserveAspectRatio="none"><line x1="0" y1="9" x2="100" y2="9" stroke="currentColor" stroke-width="1"/></svg>`;
  }
  const def = DIVIDER_CATALOG[style as Exclude<DividerStyle, 'none'>];
  const moves = def.cutPath
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`)
    .join(' ');
  // Close back along the band's bottom (y=10) to the first point.
  const last = def.cutPath[def.cutPath.length - 1]!;
  const path = `${moves} L${last[0]},10 L${def.cutPath[0]![0]},10 Z`;
  return `<svg viewBox="0 0 100 10" preserveAspectRatio="none"><path d="${path}" fill="currentColor"/></svg>`;
}
