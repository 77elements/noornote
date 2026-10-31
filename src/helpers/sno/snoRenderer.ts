/**
 * SNO renderer — Canvas-2D software rasterizer for Simple Nostr Objects
 * (DECK-0003, kind 33331).
 *
 * Orthographic projection + painter's algorithm, the same approach as the
 * Quartz/Amethyst reader: SNO objects are tiny (typically <1000 faces), so a
 * dependency-free 2D-canvas renderer beats pulling in a 3D engine. Unlit with
 * a mild depth-cue term, DoubleSide (winding is not guaranteed), vertex dots
 * in every mode, as the spec's own viewer does.
 *
 * Sizing is driven by the host stage element via `fit()` — call it on mount
 * and from a ResizeObserver; the canvas keeps itself DPI-correct.
 */

import type { SnoObject, SnoRgb } from './snoParser';

const TICKS_PER_UNIT = 120;
const TWO_PI = Math.PI * 2;

/**
 * Typed-array read. All indices come from the parser, which validates every
 * index against the array it points into (§1.9 rule 8) — out-of-range is
 * impossible by construction.
 */
function at(arr: Float64Array | Int32Array, i: number): number {
  return arr[i] as number;
}

export interface SnoViewState {
  yaw: number;
  /** Camera tilt: 90° = top-down on the x-y plane, 0° = level (z up on screen). Initial: 60° (30° elevation, reference-viewer default). */
  pitch: number;
  zoom: number;
}

export class SnoCanvasRenderer {
  private sno: SnoObject;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private state: SnoViewState;
  private centerX = 0;
  private centerY = 0;
  private centerZ = 0;
  private scale = 1;
  private viewX = new Float64Array(0);
  private viewY = new Float64Array(0);
  private viewZ = new Float64Array(0);
  private pointerActive = false;
  private lastX = 0;
  private lastY = 0;
  private cleanupFns: (() => void)[] = [];

  private constructor(sno: SnoObject, canvas: HTMLCanvasElement) {
    this.sno = sno;
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('SnoCanvasRenderer: no 2d context');
    this.ctx = ctx;
    // Initial view: elevated camera (30° above the horizon), matching the
    // reference viewer on snocrash.art — objects authored lying in the x-z
    // plane (e.g. wireframe text) read from above, standing objects stay
    // upright. spin (§1.7) applies as the bearing when the author declared up.
    this.state = {
      yaw: (sno.up ? sno.spin : 0) * (Math.PI / 180),
      pitch: 60 * (Math.PI / 180),
      zoom: 1,
    };
    this.computeNormalizedPositions();
    this.attach(canvas);
  }

  /**
   * Interactive viewer: drag to rotate, wheel to zoom. Sizing is the host's
   * job — call `fit(stage)` after mounting and on container resize.
   */
  static createInteractive(
    sno: SnoObject,
    canvas: HTMLCanvasElement
  ): SnoCanvasRenderer {
    return new SnoCanvasRenderer(sno, canvas);
  }

  /** Sizes the backing store to the stage's CSS box (DPR-aware) and redraws. */
  fit(stage: HTMLElement): void {
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    if (width < 2 || height < 2) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.draw();
  }

  destroy(): void {
    this.cleanupFns.forEach(fn => fn());
    this.cleanupFns = [];
  }

  /** Drag-to-rotate + wheel-to-zoom. `touch-action: pan-y` keeps vertical page scroll native. */
  private attach(canvas: HTMLCanvasElement): void {
    const onDown = (ev: PointerEvent) => {
      this.pointerActive = true;
      this.lastX = ev.clientX;
      this.lastY = ev.clientY;
      try {
        canvas.setPointerCapture(ev.pointerId);
      } catch {
        // pointer already gone
      }
      ev.preventDefault();
    };
    const onMove = (ev: PointerEvent) => {
      if (!this.pointerActive) return;
      const dx = ev.clientX - this.lastX;
      const dy = ev.clientY - this.lastY;
      this.lastX = ev.clientX;
      this.lastY = ev.clientY;
      this.state.yaw = (this.state.yaw + dx * 0.01) % TWO_PI;
      this.state.pitch = Math.min(
        Math.PI,
        Math.max(0, this.state.pitch + dy * 0.01)
      );
      this.draw();
    };
    const onUp = (ev: PointerEvent) => {
      this.pointerActive = false;
      try {
        canvas.releasePointerCapture(ev.pointerId);
      } catch {
        // pointer already released
      }
    };
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
      this.state.zoom = Math.min(10, Math.max(0.2, this.state.zoom * factor));
      this.draw();
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.style.touchAction = 'pan-y';
    canvas.classList.add('sno__canvas');

    this.cleanupFns.push(() => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
    });
  }

  /** Centers positions on the bounding box; rotation/projection happen per draw. */
  private computeNormalizedPositions(): void {
    const vertexCount = this.sno.positions.length / 3;
    this.viewX = new Float64Array(vertexCount);
    this.viewY = new Float64Array(vertexCount);
    this.viewZ = new Float64Array(vertexCount);

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < vertexCount; i++) {
      const x = at(this.sno.positions, i * 3) / TICKS_PER_UNIT;
      const y = at(this.sno.positions, i * 3 + 1) / TICKS_PER_UNIT;
      const z = at(this.sno.positions, i * 3 + 2) / TICKS_PER_UNIT;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
      this.viewX[i] = x;
      this.viewY[i] = y;
      this.viewZ[i] = z;
    }
    this.centerX = (minX + maxX) / 2;
    this.centerY = (minY + maxY) / 2;
    this.centerZ = (minZ + maxZ) / 2;
  }

  private draw(): void {
    const { ctx, canvas } = this;
    const vertexCount = this.viewX.length;
    // extent = grid half-width in model units; padding keeps strokes inside.
    this.scale =
      (Math.min(canvas.width, canvas.height) / 2 / this.sno.extent) * 0.92;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);

    const px = new Float64Array(vertexCount);
    const py = new Float64Array(vertexCount);
    const pz = new Float64Array(vertexCount);
    const cosYaw = Math.cos(this.state.yaw);
    const sinYaw = Math.sin(this.state.yaw);
    const cosPitch = Math.cos(this.state.pitch);
    const sinPitch = Math.sin(this.state.pitch);
    for (let i = 0; i < vertexCount; i++) {
      const x = at(this.viewX, i) - this.centerX;
      const y = at(this.viewY, i) - this.centerY;
      const z = at(this.viewZ, i) - this.centerZ;
      // Yaw around the up axis (z), then tilt the camera by pitch.
      const vx = x * cosYaw - y * sinYaw;
      const vy = x * sinYaw + y * cosYaw;
      px[i] = vx * this.scale;
      py[i] = (vy * cosPitch - z * sinPitch) * this.scale;
      pz[i] = vy * sinPitch + z * cosPitch;
    }

    if (this.sno.mode === 'solid' && this.sno.faces.length > 0) {
      this.drawSolid(px, py, pz);
    } else if (this.sno.mode === 'lines' && this.sno.faces.length > 0) {
      this.drawEdges(px, py, pz);
    } else if (this.sno.mode === 'lines') {
      // Wireframe without faces: connect the vertices in their given order.
      this.drawPolyline(px, py);
    }
    this.drawVertexDots(px, py);

    ctx.restore();
  }

  private css(c: SnoRgb, shade: number): string {
    const r = Math.min(255, Math.round(c[0] * shade));
    const g = Math.min(255, Math.round(c[1] * shade));
    const b = Math.min(255, Math.round(c[2] * shade));
    return `rgb(${r},${g},${b})`;
  }

  /** Painter's algorithm: sort faces far → near, flat-shade with a Lambert depth cue. */
  private drawSolid(
    px: Float64Array,
    py: Float64Array,
    pz: Float64Array
  ): void {
    const faces = this.sno.faces;
    const faceCount = faces.length / 3;
    const order: number[] = new Array<number>(faceCount);
    const depths = new Float64Array(faceCount);
    for (let f = 0; f < faceCount; f++) {
      order[f] = f;
      depths[f] =
        (at(pz, faces[f * 3]!) +
          at(pz, faces[f * 3 + 1]!) +
          at(pz, faces[f * 3 + 2]!)) /
        3;
    }
    order.sort((a, b) => at(depths, b) - at(depths, a));

    // Fixed view-space light direction (normalized-ish).
    const lx = -0.3;
    const ly = -0.4;
    const lz = 0.86;
    for (const f of order) {
      const a = faces[f * 3]!;
      const b = faces[f * 3 + 1]!;
      const c = faces[f * 3 + 2]!;
      const color = this.sno.faceColors?.[f] ?? this.averageColor(a, b, c);
      const ux = at(px, b) - at(px, a);
      const uy = at(py, b) - at(py, a);
      const uz = at(pz, b) - at(pz, a);
      const wx = at(px, c) - at(px, a);
      const wy = at(py, c) - at(py, a);
      const wz = at(pz, c) - at(pz, a);
      const nx = uy * wz - uz * wy;
      const ny = uz * wx - ux * wz;
      const nz = ux * wy - uy * wx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      // abs(): DoubleSide — winding is not guaranteed, never draw black backsides.
      const lambert = Math.abs((nx * lx + ny * ly + nz * lz) / len);
      const shade = 0.72 + 0.28 * lambert;

      this.ctx.beginPath();
      this.ctx.moveTo(at(px, a), at(py, a));
      this.ctx.lineTo(at(px, b), at(py, b));
      this.ctx.lineTo(at(px, c), at(py, c));
      this.ctx.closePath();
      this.ctx.fillStyle = this.css(color, shade);
      this.ctx.fill();
    }
  }

  private averageColor(a: number, b: number, c: number): SnoRgb {
    const ca = this.sno.colors[a]!;
    const cb = this.sno.colors[b]!;
    const cc = this.sno.colors[c]!;
    return [
      (ca[0] + cb[0] + cc[0]) / 3,
      (ca[1] + cb[1] + cc[1]) / 3,
      (ca[2] + cb[2] + cc[2]) / 3,
    ];
  }

  /** Wireframe of the faces: every edge drawn once (shared-edge dedup). */
  private drawEdges(
    px: Float64Array,
    py: Float64Array,
    pz: Float64Array
  ): void {
    const seen = new Set<string>();
    const faces = this.sno.faces;
    this.ctx.lineCap = 'round';
    this.ctx.lineWidth = Math.max(1.5, this.canvas.width / 300);
    for (let f = 0; f < faces.length; f += 3) {
      for (let e = 0; e < 3; e++) {
        const a = faces[f + e]!;
        const b = faces[f + ((e + 1) % 3)]!;
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        this.strokeSegment(px, py, pz, a, b);
      }
    }
  }

  private drawPolyline(px: Float64Array, py: Float64Array): void {
    this.ctx.lineCap = 'round';
    this.ctx.lineWidth = Math.max(1.5, this.canvas.width / 300);
    for (let i = 0; i + 1 < px.length; i++) {
      this.ctx.beginPath();
      this.ctx.moveTo(at(px, i), at(py, i));
      this.ctx.lineTo(at(px, i + 1), at(py, i + 1));
      this.ctx.strokeStyle = this.css(this.sno.colors[i]!, 0.95);
      this.ctx.stroke();
    }
  }

  private strokeSegment(
    px: Float64Array,
    py: Float64Array,
    pz: Float64Array,
    a: number,
    b: number
  ): void {
    // Depth cue: the farther of the two endpoints darkens the segment slightly.
    const depth = (at(pz, a) + at(pz, b)) / 2;
    const rel = Math.max(-1, Math.min(1, depth / (2 * this.sno.extent)));
    const shade = 0.75 + 0.25 * ((rel + 1) / 2);
    this.ctx.beginPath();
    this.ctx.moveTo(at(px, a), at(py, a));
    this.ctx.lineTo(at(px, b), at(py, b));
    this.ctx.strokeStyle = this.css(this.sno.colors[a]!, shade);
    this.ctx.stroke();
  }

  private drawVertexDots(px: Float64Array, py: Float64Array): void {
    const radius = Math.max(1.5, this.canvas.width / 320);
    for (let i = 0; i < px.length; i++) {
      this.ctx.beginPath();
      this.ctx.arc(at(px, i), at(py, i), radius, 0, TWO_PI);
      this.ctx.fillStyle = this.css(this.sno.colors[i]!, 1);
      this.ctx.fill();
    }
  }
}
