# Calibration

Two things drift between sessions and have to be handled per-user:

1. **Zero offset.** The four sensors don't read exactly zero with no load.
   Each board has a small per-sensor bias.
2. **Body asymmetry.** Almost everyone leans slightly. Without correction,
   the map drifts.

## First-time calibration

Run `python balance_bridge.py --calibrate`. The bridge will:

1. Ask you to step OFF the board, then capture 3 seconds of zero readings.
   These become `zero_TL`, `zero_TR`, `zero_BL`, `zero_BR` in
   `bridge/calibration.json`.
2. Ask you to step ON the board and stand still. Optionally enter your body
   weight in kg; the bridge derives a `units_per_kg` scale.

Calibration is saved to `bridge/calibration.json`. It's git-ignored — your
weight stays local.

## Per-session re-zero

Body asymmetry varies day to day. The frontend doesn't currently re-zero on
session start, but the architecture supports it: when you click into the
map page, capture COP for the first 2 seconds and subtract that as a
session offset. (`TODO` in `map.js` — file an issue if you want this.)

## Foot placement

The Wii Balance Board has small ridges where the feet are supposed to go,
but they're shallow. For repeatable sessions:

1. Cut two 26 × 10 cm rectangles of low-tack masking tape.
2. Stand naturally, mark your foot outlines on the tape.
3. Stick them to the top surface of the board.

Without this step, foot placement drifts a few centimeters between
sessions and your "zero tilt" position changes with it.

## Verifying axis mapping

Different kernel versions have mapped the board's four sensors to different
ABS axis codes. The bridge defaults to a mapping that works on Linux 5.x+
on most distros. If your COP indicator moves opposite to your tilt:

```bash
python balance_bridge.py --probe
```

Press each corner of the board in turn (TL → TR → BR → BL). Note which
axis name (e.g. `ABS_HAT0X`) changes. Edit `bridge/calibration.json`:

```json
"axis_map": {
  "TL": "ABS_HAT1X",
  "TR": "ABS_HAT0X",
  "BL": "ABS_HAT1Y",
  "BR": "ABS_HAT0Y"
}
```

Then restart the bridge.
