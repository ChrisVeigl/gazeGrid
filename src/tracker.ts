// tracker.ts — connection helpers around the tobiifree SDK.
// Mirrors what the tobiifree demo does on connect:
//   1. open the device over WebUSB (wasm TTP core in the SDK)
//   2. if the device's display area was reset (power cycle), restore the
//      last known good one (or a default)
//   3. re-apply the stored on-device calibration blob

import { Tobii, type Source, type DisplayArea } from './sdk';

const TOBII_VID = 0x2104;
const TOBII_PID_RUNTIME = 0x0313;
const FILTERS = [{ vendorId: TOBII_VID, productId: TOBII_PID_RUNTIME }];

// Same storage keys as the demo app, so the two share state when served
// from the same origin.
const KEY_AREA = 'tobii_last_good_area';
const KEY_CAL = 'tobii_onboard_cal';
const KEY_CAL_SIG = 'gazegrid_cal_area_sig';   // display area the blob was calibrated for

// 400 mm x 300 mm plane, bottom-left at (-200, 0, 0), tracker-relative.
const DEFAULT_AREA: DisplayArea = {
  tl: { x: -200, y: 300, z: 0 },
  tr: { x: 200, y: 300, z: 0 },
  bl: { x: -200, y: 0, z: 0 },
};

export const webUsbSupported = (): boolean =>
  typeof navigator !== 'undefined' && 'usb' in navigator;

/** Shows the browser's device chooser (needs a user gesture). */
export function pickDevice(): Promise<USBDevice> {
  return navigator.usb.requestDevice({ filters: FILTERS });
}

/** A tracker the user already granted access to on this origin, if any. */
export async function findGrantedDevice(): Promise<USBDevice | null> {
  const devices = await navigator.usb.getDevices();
  return devices.find((d) => d.vendorId === TOBII_VID && d.productId === TOBII_PID_RUNTIME) ?? null;
}

export interface ConnectResult { src: Source; notice: string | null }

/**
 * `userArea` (from the display-area dialog) is always written to the device
 * when given; otherwise the device's own area is kept (and restored from the
 * last known good one after a power cycle).
 */
export async function connectDevice(
  device: USBDevice,
  userArea: DisplayArea | null = null,
  sig = '',
): Promise<ConnectResult> {
  const src = await Tobii.fromUsb({ device });
  let notice: string | null = null;
  try {
    notice = await restoreDeviceState(src, userArea, sig);
  } catch (e) {
    console.warn('[tracker] restoring device state failed', e);
  }
  return { src, notice };
}

// ── display area ────────────────────────────────────────────────────

function isResetArea(a: DisplayArea): boolean {
  const w = Math.abs(a.tr.x - a.tl.x);
  const h = Math.abs(a.tl.y - a.bl.y);
  return w < 50 || h < 50;
}

function loadLastGoodArea(): DisplayArea | null {
  try {
    const s = localStorage.getItem(KEY_AREA);
    return s ? (JSON.parse(s) as DisplayArea) : null;
  } catch { return null; }
}

function saveLastGoodArea(a: DisplayArea): void {
  try { localStorage.setItem(KEY_AREA, JSON.stringify(a)); } catch { /* ignore */ }
}

async function restoreDeviceState(
  src: Source, userArea: DisplayArea | null, sig: string,
): Promise<string | null> {
  try {
    if (userArea) {
      console.log('[tracker] applying configured display area', userArea);
      await src.setDisplayAreaCorners(userArea);
      saveLastGoodArea(userArea);
    } else {
      const area = src.displayArea ?? (await src.getDisplayArea());
      if (isResetArea(area)) {
        const fallback = loadLastGoodArea() ?? DEFAULT_AREA;
        console.log('[tracker] device display area was reset, applying', fallback);
        await src.setDisplayAreaCorners(fallback);
      } else {
        saveLastGoodArea(area);
      }
    }
  } catch (e) {
    console.warn('[tracker] display area setup failed', e);
  }

  const blob = loadCalBlob();
  if (!blob) return null;
  // A calibration is only valid for the display area it was made with.
  const storedSig = storedCalSig();
  if (storedSig !== null && storedSig !== sig) {
    return 'The display area changed since the last calibration — please recalibrate.';
  }
  try {
    await src.calApply(blob);
    console.log(`[tracker] restored on-device calibration (${blob.byteLength} B)`);
  } catch (e) {
    console.warn('[tracker] restoring calibration failed', e);
  }
  return null;
}

export function storedCalSig(): string | null {
  try { return localStorage.getItem(KEY_CAL_SIG); } catch { return null; }
}

// ── calibration blob persistence ────────────────────────────────────

export function saveCalBlob(blob: Uint8Array, sig: string): void {
  // Chunked: spreading a big Uint8Array into fromCharCode overflows the stack.
  let bin = '';
  const CHUNK = 8192;
  for (let i = 0; i < blob.byteLength; i += CHUNK) {
    bin += String.fromCharCode(...blob.subarray(i, i + CHUNK));
  }
  try { localStorage.setItem(KEY_CAL, btoa(bin)); localStorage.setItem(KEY_CAL_SIG, sig); } catch (e) {
    console.warn('[tracker] could not store calibration blob', e);
  }
}

export function loadCalBlob(): Uint8Array | null {
  try {
    const b64 = localStorage.getItem(KEY_CAL);
    if (!b64) return null;
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return null; }
}
