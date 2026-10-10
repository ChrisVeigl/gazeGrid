// displayArea.ts — tobii.json-style display_area config <-> device corners.
//
// Format (same as tobiifreed's ~/.config/tobii.json):
//   { "display_area": { "w_mm": 300, "h_mm": 190, "cx": -30, "cy": -140,
//                       "z_mm": 50, "tilt": 0 } }
//
// cx / cy = position of the TRACKER relative to the screen centre in mm
// (x right, y up). Besides numbers they accept anchor expressions:
//   cx: "l", "c", "r"  (+/- offset)     cy: "t", "c", "b"  (+/- offset)
//   e.g. cy: "b - 10" = 10 mm below the bottom edge of the screen.
// tilt: degrees, 0 = flush, positive = top edge tilted AWAY from the user,
//       negative = toward the user (same direction as the tobiifree demo's tilt slider).
// z_mm: Z of the screen plane in tracker space (+Z points toward the user).
//
// Note: the demo's own sliders use another parametrisation (cx = screen centre x,
// cy = screen bottom edge y, both relative to the tracker; tilt in mm), so their
// signs are the reverse of cx/cy here.


import type { DisplayArea } from './sdk';

export interface AreaConfig {
  w_mm: number; h_mm: number; z_mm: number; tilt: number; cx: number; cy: number;
}

export type ParseResult =
  | { ok: true; cfg: AreaConfig; corners: DisplayArea }
  | { ok: false; error: string };

const DEFAULT_CY = 'b - 10';

function evalPos(v: unknown, half: number, vertical: boolean, name: string): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') throw new Error(`"${name}" must be a number or an anchor expression`);
  const m = /^\s*([tblrc])\s*(?:([+-])\s*(\d+(?:\.\d+)?))?\s*$/i.exec(v);
  if (!m) throw new Error(`"${name}": cannot parse "${v}" (examples: "b - 10", "c", "t + 5")`);
  const a = m[1]!.toLowerCase();
  let base: number;
  if (a === 'c') base = 0;
  else if (vertical && a === 't') base = half;
  else if (vertical && a === 'b') base = -half;
  else if (!vertical && a === 'l') base = -half;
  else if (!vertical && a === 'r') base = half;
  else throw new Error(`"${name}": anchor "${a}" is not valid for the ${vertical ? 'vertical' : 'horizontal'} axis`);
  return m[2] ? base + (m[2] === '-' ? -1 : 1) * Number(m[3]) : base;
}

function num(o: Record<string, unknown>, key: string, def?: number): number {
  const v = o[key];
  if (v === undefined) {
    if (def === undefined) throw new Error(`"${key}" is required`);
    return def;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`"${key}" must be a number`);
  return v;
}

export function parseAreaText(text: string): ParseResult {
  try {
    let j: unknown;
    try { j = JSON.parse(text); } catch (e) { throw new Error(`Invalid JSON: ${(e as Error).message}`); }
    if (!j || typeof j !== 'object') throw new Error('Expected a JSON object');
    const root = j as Record<string, unknown>;
    const o = (root.display_area ?? root) as Record<string, unknown>;
    if (!o || typeof o !== 'object') throw new Error('"display_area" must be an object');

    const w = num(o, 'w_mm');
    const h = num(o, 'h_mm');
    const z = num(o, 'z_mm', 0);
    const tilt = num(o, 'tilt', 0);
    if (w < 50 || h < 50) throw new Error('w_mm and h_mm must be at least 50');
    if (Math.abs(tilt) > 80) throw new Error('tilt must be within ±80°');
    const cx = evalPos(o.cx ?? 0, w / 2, false, 'cx');
    const cy = evalPos(o.cy ?? DEFAULT_CY, h / 2, true, 'cy');
    const cfg: AreaConfig = { w_mm: w, h_mm: h, z_mm: z, tilt, cx, cy };
    return { ok: true, cfg, corners: cornersFromConfig(cfg) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Same maths as tobiifree's Tracker.setDisplayArea (driver/src/tracker.zig). */
export function cornersFromConfig(c: AreaConfig): DisplayArea {
  const ox = -c.cx - c.w_mm / 2;     // bottom-left x in tracker space
  const oy = -c.cy - c.h_mm / 2;     // bottom-left y in tracker space
  const a = (c.tilt * Math.PI) / 180;
  const tlY = oy + c.h_mm * Math.cos(a);
  const tlZ = c.z_mm - c.h_mm * Math.sin(a);
  // +Z points toward the user, so a top edge tilted away has a SMALLER z.
  // (Matches the demo: tl.z = bl.z - tilt. tobiifreed's tracker.zig uses "+ h*sin"
  // although its comment says positive = away - the two disagree upstream.)


  return {
    tl: { x: ox, y: tlY, z: tlZ },
    tr: { x: ox + c.w_mm, y: tlY, z: tlZ },
    bl: { x: ox, y: oy, z: c.z_mm },
  };
}

/** Inverse, to show what the device currently has. */
export function configFromCorners(a: DisplayArea): AreaConfig {
  const r = (v: number) => Math.round(v * 10) / 10;
  const w = Math.abs(a.tr.x - a.tl.x);
  const dy = a.tl.y - a.bl.y;
  const dz = a.bl.z - a.tl.z;    // > 0 when the top edge is farther from the user
  const h = Math.hypot(dy, dz);
  return {
    w_mm: r(w), h_mm: r(h), z_mm: r(a.bl.z), tilt: r((Math.atan2(dz, dy) * 180) / Math.PI),
    cx: r(-(a.bl.x + w / 2)), cy: r(-(a.bl.y + h / 2)),
  };
}

/** Panel size from the diagonal and the pixel aspect ratio (browser knows only the latter). */
export function sizeFromDiagonal(inches: number, pxW: number, pxH: number): { w_mm: number; h_mm: number } {
  const d = inches * 25.4;
  const n = Math.hypot(pxW, pxH);
  return { w_mm: Math.round((d * pxW) / n), h_mm: Math.round((d * pxH) / n) };
}

/** Short signature used to tie a stored calibration to the area it was made with. */
export function areaSig(a: DisplayArea | null): string {
  if (!a) return '';
  const r = (v: number) => Math.round(v * 10) / 10;
  return JSON.stringify([a.tl, a.tr, a.bl].map((p) => [r(p.x), r(p.y), r(p.z)]));
}

export function describeConfig(c: AreaConfig, pxW: number, pxH: number): string {
  const below = c.cy + c.h_mm / 2;   // tracker y relative to the bottom edge
  const parts = [
    `${c.w_mm}×${c.h_mm} mm`,
    `tracker ${Math.abs(Math.round(c.cx))} mm ${c.cx < 0 ? 'left of' : 'right of'} centre`,
    Math.abs(below) < 0.5 ? 'on the bottom edge'
      : `${Math.abs(Math.round(below))} mm ${below < 0 ? 'below' : 'above'} the bottom edge`,
  ];
  let s = parts.join(' · ');
  const ar = c.w_mm / c.h_mm;
  const sr = pxW / pxH;
  if (Math.abs(ar - sr) / sr > 0.03) {
    s += ` · ⚠ aspect ${ar.toFixed(2)} differs from the screen's ${sr.toFixed(2)} (gaze will be distorted)`;
  }
  return s;
}
