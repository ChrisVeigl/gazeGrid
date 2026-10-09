// calibration.ts — on-device (onboard) calibration, ported from the
// tobiifree demo's runOnboardCalibration().
//
// Flow: fullscreen -> startCalibration -> for each point: show dot, wait for
// the user to look at it and click / press Space / Enter, then
// addCalibrationPoint(nx, ny) (device collects gaze) -> finishCalibration
// (device fits its model and returns the blob, which we persist so it can be
// re-applied after a power cycle).

import type { Source } from './sdk';

export type CalPoints = 5 | 9 | 16;
export type CalResult = 'done' | 'cancelled' | 'error';

export interface CalUi {
  overlay: HTMLElement;   // #cal-overlay
  dot: HTMLElement;       // #onboard-cal-dot
  status: HTMLElement;    // #cal-status
}

/** Normalised target positions; first point is the centre. Same as the demo. */
export function makeCalGrid(n: CalPoints): [number, number][] {
  const margin = 0.1;
  if (n === 5) {
    return [
      [0.5, 0.5],
      [margin, margin], [1 - margin, margin],
      [margin, 1 - margin], [1 - margin, 1 - margin],
    ];
  }
  if (n === 9) {
    const pts: [number, number][] = [[0.5, 0.5]];
    for (const y of [margin, 0.5, 1 - margin])
      for (const x of [margin, 0.5, 1 - margin])
        if (x !== 0.5 || y !== 0.5) pts.push([x, y]);
    return pts;
  }
  const pts: [number, number][] = [[0.5, 0.5]];
  const step = (1 - 2 * margin) / 3;
  const v = [margin, margin + step, 1 - margin - step, 1 - margin];
  for (const y of v)
    for (const x of v)
      if (x !== 0.5 || y !== 0.5) pts.push([x, y]);
  return pts;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const nextFrames = async (n: number) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => requestAnimationFrame(() => r()));
};
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runOnboardCalibration(
  tracker: Source,
  nPoints: CalPoints,
  ui: CalUi,
  onBlob: (blob: Uint8Array) => void,
): Promise<CalResult> {
  const enteredFullscreen = !document.fullscreenElement;
  (document.activeElement as HTMLElement | null)?.blur();

  // Targets are positioned in fractions of the viewport, which only equals
  // "fraction of the display" in fullscreen — so calibration requires it.
  try {
    if (enteredFullscreen) await document.documentElement.requestFullscreen();
  } catch (e) {
    ui.status.textContent = `Fullscreen failed: ${msg(e)}`;
    return 'error';
  }
  await nextFrames(3); // let the viewport settle at full-screen size

  let cancelled = false;
  let abortWait: (() => void) | null = null;
  let current: [number, number] | null = null;

  const cancel = () => { cancelled = true; abortWait?.(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel(); };
  const onFsChange = () => { if (!document.fullscreenElement) cancel(); };
  const place = () => {
    if (!current) return;
    ui.dot.style.left = `${current[0] * window.innerWidth}px`;
    ui.dot.style.top = `${current[1] * window.innerHeight}px`;
  };

  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', place);
  document.addEventListener('fullscreenchange', onFsChange);

  ui.overlay.classList.add('active');
  ui.overlay.style.cursor = 'crosshair';
  ui.dot.style.display = 'none';

  const waitForCapture = () => new Promise<boolean>((resolve) => {
    const done = (v: boolean) => {
      ui.overlay.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onCaptureKey);
      abortWait = null;
      resolve(v);
    };
    const onClick = () => done(true);
    const onCaptureKey = (e: KeyboardEvent) => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); done(true); }
    };
    ui.overlay.addEventListener('click', onClick);
    window.addEventListener('keydown', onCaptureKey);
    abortWait = () => done(false);
    if (cancelled) done(false);
  });

  let result: CalResult = 'done';
  try {
    ui.status.textContent = 'Starting calibration…';
    await tracker.startCalibration();

    const pts = makeCalGrid(nPoints);
    for (let i = 0; i < pts.length; i++) {
      if (cancelled) break;
      const [nx, ny] = pts[i]!;
      current = [nx, ny];
      place();
      ui.dot.style.display = 'block';
      ui.dot.classList.remove('collecting');
      ui.overlay.style.cursor = 'crosshair';
      ui.status.textContent =
        `Point ${i + 1}/${pts.length} — look at the dot, then click or press Space · Esc cancels`;

      if (!(await waitForCapture()) || cancelled) break;

      ui.overlay.style.cursor = 'none';
      ui.dot.classList.add('collecting');
      ui.status.textContent = `Point ${i + 1}/${pts.length} — hold your gaze…`;
      try {
        await tracker.addCalibrationPoint(nx, ny);
      } catch (e) {
        console.warn(`[cal] addCalibrationPoint(${nx}, ${ny}) failed`, e);
        ui.status.textContent = `Point ${i + 1} failed — ${msg(e)}`;
        await sleep(1500);
      }
      ui.dot.classList.remove('collecting');
    }

    ui.dot.style.display = 'none';
    if (cancelled) {
      ui.status.textContent = 'Cancelled';
      result = 'cancelled';
    } else {
      ui.status.textContent = 'Computing calibration…';
      const blob = await tracker.finishCalibration();
      onBlob(blob);
      ui.status.textContent = `Calibration complete · ${blob.byteLength} bytes stored`;
      await sleep(1200);
    }
  } catch (e) {
    console.error('[cal]', e);
    ui.status.textContent = `Error: ${msg(e)}`;
    result = 'error';
    await sleep(2000);
  } finally {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', place);
    document.removeEventListener('fullscreenchange', onFsChange);
    abortWait = null;
    ui.overlay.classList.remove('active');
    ui.overlay.style.cursor = '';
    ui.dot.style.display = 'none';
    ui.dot.classList.remove('collecting');
    // Leave fullscreen only if the calibration itself entered it.
    if (enteredFullscreen && document.fullscreenElement) {
      try { await document.exitFullscreen(); } catch { /* ignore */ }
    }
  }
  return result;
}
