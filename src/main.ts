// main.ts — 5 x 4 grid selected by gaze (Tobii ET5 via tobiifree WebUSB SDK).
// Without a tracker the mouse pointer simulates gaze, so the dwell logic can
// be tried out immediately.

import './style.css';
import type { Source, GazeSample, DisplayArea } from './sdk';
import { DwellSelector, type Pt } from './dwell';
import { runOnboardCalibration, type CalPoints } from './calibration';
import { connectDevice, findGrantedDevice, pickDevice, saveCalBlob, storedCalSig, webUsbSupported } from './tracker';
import {
  areaSig, configFromCorners, describeConfig, parseAreaText, sizeFromDiagonal,
} from './displayArea';

const DEFAULT_COLS = 5;
const DEFAULT_ROWS = 4;
const MAX_DIM = 10;
const STALE_MS = 250;     // tracker silent this long -> treat gaze as lost
const SACCADE_PX = 150;   // bigger jumps bypass smoothing so the dot isn't laggy
const CONTROL = 0;         // index of the start/stop cell (first cell)
const KEY_DWELL = 'gazegrid_dwell_ms';
const KEY_COLS = 'gazegrid_cols';
const KEY_ROWS = 'gazegrid_rows';
const MIN_DWELL = 20;
const MAX_DWELL = 2500;
const KEY_AREA_TEXT = 'gazegrid_display_area';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};
const connectBtn = $<HTMLButtonElement>('connect');
const calBtn = $<HTMLButtonElement>('calibrate');
const fsBtn = $<HTMLButtonElement>('fullscreen');
const clearBtn = $<HTMLButtonElement>('clear');
const statusEl = $('status');
const lastEl = $('last');
const msgEl = $('msg');
const gridEl = $('grid');
const dotEl = $('gaze-dot');
const dwellInput = $<HTMLInputElement>('dwell');
const dwellVal = $('dwell-val');
const showGaze = $<HTMLInputElement>('show-gaze');
const calPts = $<HTMLSelectElement>('cal-pts');
const colsSel = $<HTMLSelectElement>('cols');
const rowsSel = $<HTMLSelectElement>('rows');

const areaDlg = $<HTMLDialogElement>('area-dlg');

// ── display area (tobii.json format) ────────────────────────────────
let areaCorners: DisplayArea | null = null;   // user-configured; null = keep the device's own
{
  const saved = localStorage.getItem(KEY_AREA_TEXT);
  const r = saved ? parseAreaText(saved) : null;
  if (r?.ok) areaCorners = r.corners;
}

// ── grid ────────────────────────────────────────────────────────────
const readDim = (key: string, def: number): number => {
  const n = Number(localStorage.getItem(key));
  return Number.isInteger(n) && n >= 1 && n <= MAX_DIM ? n : def;
};
let cols = readDim(KEY_COLS, DEFAULT_COLS);
let rows = readDim(KEY_ROWS, DEFAULT_ROWS);

for (const sel of [colsSel, rowsSel]) {
  for (let n = 1; n <= MAX_DIM; n++) sel.add(new Option(String(n), String(n)));
}
colsSel.value = String(cols);
rowsSel.value = String(rows);

const cells: HTMLButtonElement[] = [];   // mutated in place by buildGrid()

// ── start/stop control (first cell) ─────────────────────────────────
const ICON_STOP = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="8" y="8" width="8" height="8" rx="1.6" fill="currentColor"/></svg>`;
const ICON_PLAY = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 7.9 16.4 12 10 16.1Z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
let gazePaused = false;

function renderControl(): void {
  const c = cells[CONTROL];
  if (!c) return;
  c.classList.toggle('running', !gazePaused);
  c.classList.toggle('paused', gazePaused);
  c.innerHTML = gazePaused
    ? `${ICON_PLAY}<span class="cap">Resume</span>`
    : `${ICON_STOP}<span class="cap">Pause</span>`;
  c.setAttribute('aria-label', gazePaused ? 'Resume gaze selection' : 'Pause gaze selection');
}

/** Paused: gaze selection is bypassed; only the control cell stays active. */
function applyPaused(): void {
  cells.forEach((c, i) => {
    if (i === CONTROL) return;
    c.disabled = gazePaused;             // also blocks mouse clicks
    c.classList.toggle('inactive', gazePaused);
  });
  selector.setOnly(gazePaused ? CONTROL : null);
  renderControl();
}

function setGazePaused(paused: boolean): void {
  gazePaused = paused;
  applyPaused();
  lastEl.textContent = paused
    ? `Gaze selection paused — look at cell ${CONTROL + 1} to resume`
    : 'Gaze selection resumed';
}

// ── dwell selector ──────────────────────────────────────────────────
const selector = new DwellSelector(cells, (i) => {
  cells[i]!.classList.add('pulse');
  cells[i]!.click();          // same code path as a mouse click
});

function relayout(): void {
  selector.refresh();
  const r = cells[0]?.getBoundingClientRect();
  if (!r) return;
  const m = Math.round(Math.min(r.width, r.height));
  if (gridEl.style.getPropertyValue('--cell-min') !== `${m}px`) gridEl.style.setProperty('--cell-min', `${m}px`);
  gridEl.classList.toggle('compact', m < 80);
  // hit margins shrink with small cells
  selector.cfg.insetPx = Math.min(8, m * 0.1);
  selector.cfg.stickyPx = Math.min(24, m * 0.3);
}

function buildGrid(): void {
  gridEl.replaceChildren();
  cells.length = 0;
  gridEl.style.setProperty('--cols', String(cols));
  gridEl.style.setProperty('--rows', String(rows));
  gridEl.style.setProperty('--gap', cols > 7 || rows > 7 ? '8px' : '14px');
  for (let i = 0; i < cols * rows; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cell';
    if (i === CONTROL) {
      b.classList.add('control');
      b.addEventListener('click', () => setGazePaused(!gazePaused));
    } else {
      b.setAttribute('aria-pressed', 'false');
      b.innerHTML = `<span class="label">${i + 1}</span><span class="check" aria-hidden="true">✓</span>`;
      b.addEventListener('click', () => toggleCell(i));
    }
    b.addEventListener('animationend', () => b.classList.remove('pulse'));
    gridEl.append(b);
    cells.push(b);
  }
  selector.syncCells();
  applyPaused();          // keeps a paused state across grid changes
  relayout();
  lastEl.textContent = 'Nothing selected';
}

function onGridSizeChange(): void {
  cols = Number(colsSel.value);
  rows = Number(rowsSel.value);
  try { localStorage.setItem(KEY_COLS, String(cols)); localStorage.setItem(KEY_ROWS, String(rows)); } catch { /* ignore */ }
  buildGrid();
}
colsSel.addEventListener('change', onGridSizeChange);
rowsSel.addEventListener('change', onGridSizeChange);

function toggleCell(i: number): void {
  const cell = cells[i]!;
  const on = !cell.classList.contains('selected');
  cell.classList.toggle('selected', on);
  cell.setAttribute('aria-pressed', String(on));
  const row = Math.floor(i / cols) + 1;
  const col = (i % cols) + 1;
  const count = cells.filter((c) => c.classList.contains('selected')).length;
  lastEl.textContent = `${on ? 'Selected' : 'Deselected'} ${i + 1} (row ${row}, col ${col}) · ${count} selected`;
}

clearBtn.addEventListener('click', () => {
  cells.forEach((c) => { c.classList.remove('selected'); c.setAttribute('aria-pressed', 'false'); });
  lastEl.textContent = 'Nothing selected';
});

window.addEventListener('resize', relayout);
document.addEventListener('fullscreenchange', () => { relayout(); setTimeout(relayout, 150); updateFsButton(); });
new ResizeObserver(relayout).observe(gridEl);

const savedDwell = Number(localStorage.getItem(KEY_DWELL));
dwellInput.value = String(savedDwell >= MIN_DWELL && savedDwell <= MAX_DWELL ? savedDwell : 900);
const applyDwell = () => {
  selector.cfg.dwellMs = Number(dwellInput.value);
  dwellVal.textContent = `${dwellInput.value} ms`;
  try { localStorage.setItem(KEY_DWELL, dwellInput.value); } catch { /* ignore */ }
};
dwellInput.addEventListener('input', applyDwell);
applyDwell();
buildGrid();

// ── gaze input ──────────────────────────────────────────────────────
let tracker: Source | null = null;
let usbDevice: USBDevice | null = null;
let calRunning = false;

let normGaze: Pt | null = null;   // latest valid tracker sample, normalised 0..1
let normT = 0;
let mouseView: Pt | null = null;  // mouse position (simulation when no tracker)
let smooth: Pt | null = null;
let sampleCount = 0;

function onSample(s: GazeSample): void {
  sampleCount++;
  const p = s.gaze_point_2d_norm ?? s.gaze_point_2d_L_norm ?? s.gaze_point_2d_R_norm;
  const valid = s.validity_L === 0 || s.validity_R === 0;
  if (p && valid && Number.isFinite(p.x) && Number.isFinite(p.y)) {
    normGaze = { x: p.x, y: p.y };
    normT = performance.now();
  } else {
    normGaze = null;
  }
}

/**
 * Tracker coordinates are normalised to the *display* (0,0 = top-left of the
 * screen). In fullscreen the viewport is the display, so this is exact.
 * Windowed, we map via screen coordinates; the window-chrome offset is only
 * an estimate — use fullscreen for accurate results.
 */
function normToViewport(n: Pt): Pt {
  if (document.fullscreenElement) {
    return { x: n.x * window.innerWidth, y: n.y * window.innerHeight };
  }
  const s = screen as Screen & { availLeft?: number; availTop?: number };
  const sx = n.x * screen.width + (s.availLeft ?? 0);
  const sy = n.y * screen.height + (s.availTop ?? 0);
  const borderX = (window.outerWidth - window.innerWidth) / 2;
  const chromeY = window.outerHeight - window.innerHeight - borderX;
  return { x: sx - window.screenX - borderX, y: sy - window.screenY - chromeY };
}

window.addEventListener('pointermove', (e) => { mouseView = { x: e.clientX, y: e.clientY }; });
document.documentElement.addEventListener('mouseleave', () => { mouseView = null; });

function frame(now: number): void {
  requestAnimationFrame(frame);

  if (calRunning || areaDlg.open) {   // calibration overlay / dialog own the screen
    selector.reset();
    smooth = null;
    dotEl.style.opacity = '0';
    return;
  }

  let target: Pt | null = null;
  if (tracker) {
    if (normGaze && now - normT < STALE_MS) target = normToViewport(normGaze);
  } else {
    target = mouseView;
  }

  if (!target) {
    smooth = null;
  } else if (!smooth) {
    smooth = { ...target };
  } else {
    const d = Math.hypot(target.x - smooth.x, target.y - smooth.y);
    const a = !tracker ? 1 : d > SACCADE_PX ? 0.85 : 0.3;
    smooth.x += (target.x - smooth.x) * a;
    smooth.y += (target.y - smooth.y) * a;
  }

  if (smooth && showGaze.checked && tracker) {
    dotEl.style.transform = `translate(${smooth.x}px, ${smooth.y}px)`;
    dotEl.style.opacity = '1';
  } else {
    dotEl.style.opacity = '0';
  }

  selector.update(smooth, now);
}
requestAnimationFrame(frame);

// ── UI state ────────────────────────────────────────────────────────
function showError(text: string): void { msgEl.textContent = text; msgEl.classList.remove('warn'); msgEl.hidden = false; }
function showWarn(text: string): void { msgEl.textContent = text; msgEl.classList.add('warn'); msgEl.hidden = false; }
function clearError(): void { msgEl.textContent = ''; msgEl.hidden = true; }

function setStatus(text: string, live: boolean): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('live', live);
}

function updateUi(): void {
  connectBtn.textContent = tracker ? 'Disconnect' : 'Connect tracker';
  connectBtn.classList.toggle('primary', !tracker);
  calBtn.disabled = !tracker || calRunning;
  connectBtn.disabled = calRunning;
  if (!tracker) setStatus('Mouse simulation', false);
}

function updateFsButton(): void {
  fsBtn.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
}

setInterval(() => {   // sample-rate readout
  if (tracker && !calRunning) {
    setStatus(`Tracker · ${sampleCount} Hz${gazePaused ? ' · paused' : ''}`, sampleCount > 0 && !gazePaused);
  }
  sampleCount = 0;
}, 1000);

// ── connect / disconnect ────────────────────────────────────────────
async function connect(device?: USBDevice): Promise<void> {
  clearError();
  connectBtn.disabled = true;
  connectBtn.textContent = 'Connecting…';
  try {
    const dev = device ?? await pickDevice();
    const { src, notice } = await connectDevice(dev, areaCorners, areaSig(areaCorners));
    if (notice) showWarn(notice);
    tracker = src;
    usbDevice = dev;
    src.subscribeToGaze(onSample);
    setStatus('Tracker · waiting for data…', false);
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'NotFoundError')) {   // chooser dismissed = no error
      showError(`Connect failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  } finally {
    connectBtn.disabled = false;
    updateUi();
  }
}

async function disconnect(): Promise<void> {
  const t = tracker;
  tracker = null; usbDevice = null; normGaze = null;
  try { await t?.close(); } catch { /* ignore */ }
  updateUi();
}

connectBtn.addEventListener('click', () => { void (tracker ? disconnect() : connect()); });

if (webUsbSupported()) {
  navigator.usb.addEventListener('disconnect', (e) => {
    if (usbDevice && e.device === usbDevice) {
      void disconnect();
      showError('Tracker unplugged.');
    }
  });
  // Reuse a previously granted device without another chooser prompt.
  void findGrantedDevice().then((d) => { if (d) void connect(d); }).catch(() => { /* ignore */ });
} else {
  connectBtn.disabled = true;
  showError('WebUSB is not available. Use Chrome or Edge (desktop) on https:// or http://localhost.');
}


// ── display-area dialog ─────────────────────────────────────────────
const areaText = $<HTMLTextAreaElement>('area-json');
const areaInfo = $('area-info');
const areaDeviceBtn = $<HTMLButtonElement>('area-device');
const diagInput = $<HTMLInputElement>('diag');
const screenInfo = $('screen-info');

const pxSize = () => ({ w: screen.width, h: screen.height });
const toText = (cfg: Record<string, unknown>) => JSON.stringify({ display_area: cfg }, null, 2);

function defaultAreaText(): string {
  const { w, h } = pxSize();
  const size = sizeFromDiagonal(24, w, h);
  return toText({ ...size, cx: 0, cy: 'b - 10', z_mm: 0, tilt: 0 });
}

function refreshAreaInfo(): boolean {
  const r = parseAreaText(areaText.value);
  const { w, h } = pxSize();
  if (!r.ok) {
    areaInfo.className = 'hint err';
    areaInfo.textContent = r.error;
    return false;
  }
  areaInfo.className = 'hint ok';
  areaInfo.textContent = `✓ ${describeConfig(r.cfg, w, h)}`;
  return true;
}
areaText.addEventListener('input', refreshAreaInfo);

$('display').addEventListener('click', () => {
  const { w, h } = pxSize();
  screenInfo.textContent = `Screen: ${w}×${h} px (aspect ${(w / h).toFixed(2)})`;
  areaText.value = localStorage.getItem(KEY_AREA_TEXT) ?? defaultAreaText();
  areaDeviceBtn.disabled = !tracker;
  refreshAreaInfo();
  areaDlg.showModal();
});

$('fill-diag').addEventListener('click', () => {
  const inches = Number(diagInput.value);
  if (!(inches >= 5 && inches <= 120)) { areaInfo.className = 'hint err'; areaInfo.textContent = 'Enter a diagonal between 5 and 120 inches.'; return; }
  const { w, h } = pxSize();
  const size = sizeFromDiagonal(inches, w, h);
  // keep cx/cy/z/tilt from the current text where possible, else assume tracker bottom-centre
  const cur = parseAreaText(areaText.value);
  const rest = cur.ok
    ? { cx: cur.cfg.cx, cy: cur.cfg.cy, z_mm: cur.cfg.z_mm, tilt: cur.cfg.tilt }
    : { cx: 0, cy: 'b - 10', z_mm: 0, tilt: 0 };
  // if cy was an anchor expression in the text, keep it relative to the new height
  let cy: number | string = rest.cy;
  try {
    const o = (JSON.parse(areaText.value).display_area ?? JSON.parse(areaText.value)) as Record<string, unknown>;
    if (typeof o.cy === 'string') cy = o.cy;
    else if (cur.ok) cy = Math.round((cur.cfg.cy + cur.cfg.h_mm / 2 - size.h_mm / 2) * 10) / 10; // keep the distance to the bottom edge
  } catch { /* keep numeric */ }
  areaText.value = toText({ ...size, cx: rest.cx, cy, z_mm: rest.z_mm, tilt: rest.tilt });
  refreshAreaInfo();
});

$('area-device').addEventListener('click', async () => {
  if (!tracker) return;
  try {
    const a = tracker.displayArea ?? await tracker.getDisplayArea();
    areaText.value = toText({ ...configFromCorners(a) });
    refreshAreaInfo();
  } catch (e) {
    areaInfo.className = 'hint err';
    areaInfo.textContent = `Could not read from device: ${e instanceof Error ? e.message : String(e)}`;
  }
});

$('area-load').addEventListener('click', () => $<HTMLInputElement>('area-file').click());
$<HTMLInputElement>('area-file').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  if (f) { areaText.value = await f.text(); refreshAreaInfo(); }
  input.value = '';
});

$('area-save').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([areaText.value], { type: 'application/json' }));
  a.download = 'tobii.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

$('area-clear').addEventListener('click', () => {
  localStorage.removeItem(KEY_AREA_TEXT);
  areaCorners = null;
  areaText.value = defaultAreaText();
  refreshAreaInfo();
  areaInfo.textContent += ' · Saved area cleared; the device keeps its current area.';
});

$('area-close').addEventListener('click', () => areaDlg.close());

$('area-apply').addEventListener('click', async () => {
  const r = parseAreaText(areaText.value);
  if (!r.ok) { refreshAreaInfo(); return; }
  const prevSig = areaSig(areaCorners);
  const newSig = areaSig(r.corners);
  try { localStorage.setItem(KEY_AREA_TEXT, areaText.value); } catch { /* ignore */ }
  areaCorners = r.corners;
  if (tracker) {
    try {
      await tracker.setDisplayAreaCorners(r.corners);
    } catch (e) {
      areaInfo.className = 'hint err';
      areaInfo.textContent = `Could not write to device: ${e instanceof Error ? e.message : String(e)}`;
      return;
    }
  }
  areaDlg.close();
  const calSig = storedCalSig();
  if (tracker && newSig !== prevSig && calSig !== null && calSig !== newSig) {
    showWarn('Display area updated. The stored calibration was made for a different area — please recalibrate.');
  } else {
    clearError();
  }
});

// ── fullscreen & calibration ────────────────────────────────────────
fsBtn.addEventListener('click', () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch((e) => showError(`Fullscreen failed: ${e}`));
});
window.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLElement && e.target.closest('input, textarea, select, dialog');
  if ((e.key === 'f' || e.key === 'F') && !calRunning && !typing && !e.ctrlKey && !e.metaKey) fsBtn.click();
});

calBtn.addEventListener('click', async () => {
  if (!tracker || calRunning) return;
  clearError();
  calRunning = true;
  updateUi();
  const result = await runOnboardCalibration(
    tracker,
    Number(calPts.value) as CalPoints,
    { overlay: $('cal-overlay'), dot: $('onboard-cal-dot'), status: $('cal-status') },
    (blob) => saveCalBlob(blob, areaSig(areaCorners)),
  );
  calRunning = false;
  updateUi();
  relayout();
  if (result === 'error') showError('Calibration failed — see the browser console for details.');
});

updateUi();
updateFsButton();
