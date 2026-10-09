# Gaze Grid

A 5 x 4 grid of cells that you select with your eyes, using a Tobii Eye Tracker 5 through
[tobiifree](https://github.com/Aetherall/tobiifree) (WebUSB + wasm TTP core, no native driver).

## Run

```sh
npm install
npm run dev        # http://localhost:5174
# or: npm run build && npm run preview
```

Needs **Chrome or Edge (desktop)**. WebUSB only works on `https://` or `http://localhost`.
Linux: install the udev rule from the tobiifree repo (`assets/99-tobii.rules`) and close any other
program that holds the tracker.

## Use

1. **Connect tracker** – pick the ET5 in the browser's device chooser. Next visits reconnect automatically.
2. **Fullscreen** (or press `F`) – recommended; gaze maps exactly to the screen in fullscreen.
3. **Display…** – set the physical screen size and tracker position (see below). Do this before calibrating.
4. **Calibrate** – on-device calibration with 5 / 9 / 16 points. Look at each dot, then click or press
   Space/Enter. Esc cancels. The calibration blob is stored in localStorage and re-applied on connect.
5. Look at a cell: it grows slightly and glows more and more while you dwell; at the end a ripple plays and it is toggled (selected / deselected).
   Look away and back to trigger it again. **Clear** resets all cells. The dwell slider sets 300-2500 ms.

Without a tracker the mouse pointer simulates gaze, so you can try the dwell logic first.

## Display area (screen size + tracker position)

Browsers cannot read the physical screen size, so it is entered in the **Display…** dialog, in the
same format as tobiifreed's `tobii.json`:

```json
{ "display_area": { "w_mm": 300, "h_mm": 190, "cx": -30, "cy": -140, "z_mm": 50, "tilt": 0 } }
```

- `w_mm`, `h_mm` – visible panel size. Keep the aspect ratio equal to the screen's pixel aspect (the dialog warns otherwise).
- `cx`, `cy` – tracker position relative to the screen centre in mm (x right, y up). Anchor expressions work too:
  `cx`: `l` / `c` / `r`, `cy`: `t` / `c` / `b`, each with `+/- offset`; e.g. `"cy": "b - 10"` = 10 mm below the bottom edge.
  Omitted `cx` = 0, omitted `cy` = `"b - 10"` (tracker centred under the screen).
- `z_mm` – plane depth; `tilt` – degrees (0 = flush, negative = top toward the user).

The dialog can fill `w_mm`/`h_mm` from the screen diagonal, load/download a `tobii.json`, and read the
current values back from the device. The area is saved in localStorage and written to the device on
every connect. A stored calibration is only re-applied if it was made for the same area — after changing
the area, recalibrate.

## Files

- `src/main.ts` – UI, gaze smoothing, viewport mapping, connect/fullscreen/calibrate wiring
- `src/dwell.ts` – dwell selection (hysteresis, blink tolerance, fire-once-until-look-away)
- `src/calibration.ts` – on-device calibration flow, ported from the tobiifree demo
- `src/displayArea.ts` – tobii.json parsing (incl. anchor expressions), rect+tilt -> corners, diagonal helper
- `src/tracker.ts` – WebUSB connect, display-area restore, calibration blob persistence
- `src/sdk/` – copy of tobiifree's `sdk/src` (without the Node-only files), wasm already embedded

## License

Contains code from tobiifree, so this project is under **GPL-3.0** (see `LICENSE`).
