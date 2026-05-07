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

Body asymmetry varies day to day. The first ~2 seconds of presence on the
board after page load (or after pressing **R**) are automatically averaged
into a per-session COP offset that compensates for your resting lean. This
correction is applied to every subsequent `cop_x / cop_y` reading before
gesture classification.

Status flow: `DISCONNECTED → REZEROING → READY`. The topbar shows the
current phase. The map ignores all commands while `REZEROING` is active so
a partially-settled offset doesn't steer the map during calibration.

The offset is discarded when you press **R** or reload the page. It is
_not_ saved to disk — it is cheap to re-capture and varies with footwear
and fatigue.

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
