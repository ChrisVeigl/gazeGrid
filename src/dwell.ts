// dwell.ts — gaze dwell selection over a set of rectangular cells.
//
// Feed it a (smoothed) gaze point in viewport px every animation frame.
// A cell is "targeted" while gaze rests on it; after `dwellMs` it fires once.
// To fire again the user must look away (leave the cell for > graceMs).
//
// Anti-jitter measures:
//  - switching to a neighbouring cell needs the point `insetPx` inside it
//  - the current cell is "sticky": it keeps the target while gaze stays within
//    `stickyPx` of it (covers the gaps between cells and noisy edges)
//  - short signal losses (blinks, tracking dropouts) shorter than `graceMs`
//    do not reset the dwell timer

export interface Pt { x: number; y: number }

export interface DwellConfig {
  dwellMs: number;
  graceMs: number;
  stickyPx: number;
  insetPx: number;
}

const DEFAULTS: DwellConfig = { dwellMs: 900, graceMs: 200, stickyPx: 24, insetPx: 8 };

// Visual feedback: every cell has a smoothed `--glow` (0..1) CSS variable.
// It eases towards a target instead of jumping, so entering and leaving a
// cell both fade. Target while targeted: 0.25 at first contact, rising along
// a smoothstep to 1.0 when the dwell completes.
const GLOW_BASE = 0.25;
const TAU_UP_MS = 140;
const TAU_DOWN_MS = 260;
const smoothstep = (t: number) => t * t * (3 - 2 * t);

const inside = (r: DOMRect, p: Pt, grow = 0): boolean =>
  p.x >= r.left - grow && p.x <= r.right + grow &&
  p.y >= r.top - grow && p.y <= r.bottom + grow;

export class DwellSelector {
  readonly cfg: DwellConfig;
  private rects: DOMRect[] = [];
  private cur = -1;
  private start = 0;
  private lastSeen = 0;
  private fired = false;
  private glow: number[];
  private lastT = 0;
  private only: number | null = null;   // when set, only this cell can be targeted

  constructor(
    private readonly cells: HTMLElement[],
    private readonly onFire: (index: number) => void,
    cfg: Partial<DwellConfig> = {},
  ) {
    this.cfg = { ...DEFAULTS, ...cfg };
    this.glow = cells.map(() => 0);
    this.refresh();
  }

  /** Re-measure the cells (call after resize / fullscreen / layout change). */
  refresh(): void {
    this.rects = this.cells.map((c) => c.getBoundingClientRect());
  }

  /** Drop the current target (e.g. while calibrating). */
  reset(): void {
    this.setCurrent(-1, 0);
  }

  get current(): number { return this.cur; }

  /** Restrict targeting to a single cell (null = all cells active). */
  setOnly(index: number | null): void {
    this.only = index;
    if (index !== null && this.cur >= 0 && this.cur !== index) this.setCurrent(-1, 0);
  }

  private allowed(i: number): boolean {
    return this.only === null || this.only === i;
  }

  update(p: Pt | null, now: number): void {
    let hit = -1;
    if (p) {
      // 1. clearly inside some cell -> that cell
      hit = this.rects.findIndex((r, i) => this.allowed(i) && inside(r, p, -this.cfg.insetPx));
      // 2. else keep the current cell while we are still near it
      if (hit < 0 && this.cur >= 0 && inside(this.rects[this.cur]!, p, this.cfg.stickyPx)) {
        hit = this.cur;
      }
      // 3. else any cell the point touches at all
      if (hit < 0) hit = this.rects.findIndex((r, i) => this.allowed(i) && inside(r, p));
    }

    if (hit >= 0) {
      this.lastSeen = now;
      if (hit !== this.cur) this.setCurrent(hit, now);
    } else if (this.cur >= 0 && now - this.lastSeen > this.cfg.graceMs) {
      this.setCurrent(-1, now);
    }

    let progress = 0;
    if (this.cur >= 0) {
      progress = this.fired ? 1 : Math.min((now - this.start) / this.cfg.dwellMs, 1);
      if (!this.fired && progress >= 1) {
        this.fired = true;
        this.cells[this.cur]!.classList.add('gaze-fired');
        this.onFire(this.cur);
      }
    }
    this.stepGlow(now, progress);
  }

  private stepGlow(now: number, progress: number): void {
    const dt = this.lastT ? Math.min(now - this.lastT, 100) : 16;
    this.lastT = now;
    for (let i = 0; i < this.cells.length; i++) {
      const target = i === this.cur ? GLOW_BASE + (1 - GLOW_BASE) * smoothstep(progress) : 0;
      const g = this.glow[i]!;
      if (g === target) continue;
      const tau = target > g ? TAU_UP_MS : TAU_DOWN_MS;
      let n = g + (target - g) * (1 - Math.exp(-dt / tau));
      if (Math.abs(n - target) < 0.002) n = target;
      this.glow[i] = n;
      this.cells[i]!.style.setProperty('--glow', n.toFixed(3));
    }
  }

  private setCurrent(i: number, now: number): void {
    if (this.cur >= 0) {
      const old = this.cells[this.cur]!;
      old.classList.remove('gaze-hover', 'gaze-fired');   // --glow fades out on its own
    }
    this.cur = i;
    this.start = now;
    this.fired = false;
    if (i >= 0) this.cells[i]!.classList.add('gaze-hover');
  }
}
