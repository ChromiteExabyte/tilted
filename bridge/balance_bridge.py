#!/usr/bin/env python3
"""
balance_bridge.py — Wii Balance Board → WebSocket bridge.

Reads four corner sensors from the kernel hid-wiimote driver via evdev,
normalizes them against a per-user calibration, and broadcasts a JSON
stream over WebSocket at ~30 Hz. Gesture interpretation (pan vs zoom)
happens in the browser — this bridge just forwards clean sensor data.

Usage:
    python balance_bridge.py --probe       # print all axes raw, ctrl-C to exit
    python balance_bridge.py --calibrate   # record zero + standing weight
    python balance_bridge.py               # normal run, opens WS on :8765
"""

import argparse
import asyncio
import json
import os
import sys
import time
from dataclasses import dataclass, asdict
from pathlib import Path

import evdev
import websockets

CALIBRATION_FILE = Path(__file__).parent / "calibration.json"
DEVICE_NAME_HINTS = ("balance board", "rvl-wbc", "wii balance")
WS_HOST = "0.0.0.0"
WS_PORT = 8765
SAMPLE_HZ = 30
DEADZONE = 0.08          # ignore tilts smaller than this fraction of half-range
LEG_RAISED_THRESHOLD = 0.15  # if a side carries <15% of total weight, leg is up
MIN_TOTAL_KG = 15        # below this, treat as "stepped off"

# Default axis -> corner mapping for hid-wiimote.
# This is the mapping observed on most modern Linux kernels, but the
# `--probe` mode lets you verify and override on your hardware.
DEFAULT_AXIS_MAP = {
    "TR": "ABS_HAT0X",
    "BR": "ABS_HAT0Y",
    "TL": "ABS_HAT1X",
    "BL": "ABS_HAT1Y",
}


@dataclass
class Calibration:
    """Per-board zero offsets (raw evdev values) and standing reference weight (kg-equivalent)."""
    zero_TL: int = 0
    zero_TR: int = 0
    zero_BL: int = 0
    zero_BR: int = 0
    # Raw-units-per-kg, derived during calibration from a known body weight
    # or estimated from the standing-still capture. Default 100 is a placeholder.
    units_per_kg: float = 100.0
    axis_map: dict = None

    def __post_init__(self):
        if self.axis_map is None:
            self.axis_map = dict(DEFAULT_AXIS_MAP)

    @classmethod
    def load(cls):
        if CALIBRATION_FILE.exists():
            data = json.loads(CALIBRATION_FILE.read_text())
            return cls(**data)
        return cls()

    def save(self):
        CALIBRATION_FILE.write_text(json.dumps(asdict(self), indent=2))


def find_balance_board():
    """Locate the balance board evdev device by name. Returns evdev.InputDevice or None."""
    for path in evdev.list_devices():
        try:
            dev = evdev.InputDevice(path)
        except (PermissionError, OSError):
            continue
        name_lower = dev.name.lower()
        if any(hint in name_lower for hint in DEVICE_NAME_HINTS):
            return dev
    return None


def probe(dev):
    """Print live axis values so the user can verify mapping."""
    print(f"Probing {dev.name} at {dev.path}")
    print("Stand on the board with weight on different corners.")
    print("Watch which axis changes when you press TL / TR / BL / BR.")
    print("Update DEFAULT_AXIS_MAP or calibration.json axis_map to match.")
    print()
    print("Press Ctrl-C to exit.\n")

    # Show current absinfo for all ABS axes
    caps = dev.capabilities(verbose=False)
    abs_caps = caps.get(evdev.ecodes.EV_ABS, [])
    axis_names = {code: evdev.ecodes.ABS[code] for code, _ in abs_caps}
    last = {name: 0 for name in axis_names.values()}

    try:
        for event in dev.read_loop():
            if event.type != evdev.ecodes.EV_ABS:
                continue
            name = evdev.ecodes.ABS.get(event.code, f"ABS_{event.code}")
            if last.get(name) == event.value:
                continue
            last[name] = event.value
            line = "  ".join(f"{n}={last[n]:>6}" for n in sorted(last))
            print(f"\r{line}", end="", flush=True)
    except KeyboardInterrupt:
        print("\nDone.")


def read_corners(dev, calib, duration_s):
    """Block for duration_s seconds, return list of (TL, TR, BL, BR) raw samples."""
    code_to_name = {evdev.ecodes.ecodes[v]: v for v in calib.axis_map.values()
                    if v in evdev.ecodes.ecodes}
    name_to_corner = {v: k for k, v in calib.axis_map.items()}
    current = {"TL": 0, "TR": 0, "BL": 0, "BR": 0}
    samples = []
    end = time.time() + duration_s

    # Use a non-blocking read approach via asyncio? Simpler: select-style read with poll
    import select
    while time.time() < end:
        r, _, _ = select.select([dev.fd], [], [], 0.05)
        if not r:
            samples.append(tuple(current[c] for c in ("TL", "TR", "BL", "BR")))
            continue
        for event in dev.read():
            if event.type != evdev.ecodes.EV_ABS:
                continue
            axis_name = code_to_name.get(event.code)
            if not axis_name:
                continue
            corner = name_to_corner.get(axis_name)
            if corner:
                current[corner] = event.value
        samples.append(tuple(current[c] for c in ("TL", "TR", "BL", "BR")))
    return samples


def calibrate(dev):
    calib = Calibration.load()
    print(f"Calibrating {dev.name}.")
    print()
    input("STEP 1/2: Make sure NOTHING is on the board. Press Enter to begin zero capture...")
    print("Capturing zero baseline for 3 seconds...")
    zero_samples = read_corners(dev, calib, 3.0)
    if not zero_samples:
        print("No samples received. Is the board connected?")
        return
    avg = lambda i: sum(s[i] for s in zero_samples) / len(zero_samples)
    calib.zero_TL = int(avg(0))
    calib.zero_TR = int(avg(1))
    calib.zero_BL = int(avg(2))
    calib.zero_BR = int(avg(3))
    print(f"  Zero offsets: TL={calib.zero_TL} TR={calib.zero_TR} "
          f"BL={calib.zero_BL} BR={calib.zero_BR}")
    print()

    weight_str = input("STEP 2/2: Step ON the board, weight evenly distributed.\n"
                       "Enter your body weight in kg (or leave blank to skip scaling): ").strip()
    print("Capturing standing baseline for 3 seconds. Stay still...")
    stand_samples = read_corners(dev, calib, 3.0)
    raw_total_avg = sum(sum(s) for s in stand_samples) / len(stand_samples)
    raw_offset_total = (calib.zero_TL + calib.zero_TR
                        + calib.zero_BL + calib.zero_BR)
    net = raw_total_avg - raw_offset_total
    if weight_str:
        try:
            kg = float(weight_str)
            calib.units_per_kg = max(1.0, net / kg)
            print(f"  Scale factor: {calib.units_per_kg:.2f} raw units / kg")
        except ValueError:
            print("  Couldn't parse weight, keeping default scale.")
    else:
        print(f"  Net standing reading: {net:.0f} raw units (scale unchanged)")

    calib.save()
    print(f"\nCalibration written to {CALIBRATION_FILE}")


# -----------------------------------------------------------------------------
# Sensor → normalized state
# -----------------------------------------------------------------------------

def compute_state(raw, calib):
    """
    Translate (TL, TR, BL, BR) raw evdev values into the normalized state
    that the browser consumes. Returns a dict ready to JSON-serialize.

    Conventions:
        cop_x in [-1, +1] — negative = left, positive = right
        cop_y in [-1, +1] — negative = back, positive = forward
        Each corner is normalized weight in [0, ~1] of body weight.
    """
    tl = max(0, raw[0] - calib.zero_TL) / calib.units_per_kg
    tr = max(0, raw[1] - calib.zero_TR) / calib.units_per_kg
    bl = max(0, raw[2] - calib.zero_BL) / calib.units_per_kg
    br = max(0, raw[3] - calib.zero_BR) / calib.units_per_kg

    total = tl + tr + bl + br
    if total < MIN_TOTAL_KG:
        return {
            "ts": time.time(),
            "present": False,
            "total_kg": total,
            "TL": tl, "TR": tr, "BL": bl, "BR": br,
            "cop_x": 0.0, "cop_y": 0.0,
            "left_share": 0.0, "right_share": 0.0,
        }

    left = tl + bl
    right = tr + br
    front = tl + tr
    back = bl + br

    cop_x = (right - left) / total
    cop_y = (front - back) / total

    return {
        "ts": time.time(),
        "present": True,
        "total_kg": total,
        "TL": tl, "TR": tr, "BL": bl, "BR": br,
        "cop_x": cop_x,
        "cop_y": cop_y,
        "left_share": left / total,
        "right_share": right / total,
    }


# -----------------------------------------------------------------------------
# Async event loop: sensor reader + WebSocket broadcaster
# -----------------------------------------------------------------------------

class State:
    def __init__(self, calib):
        self.calib = calib
        self.raw = [calib.zero_TL, calib.zero_TR, calib.zero_BL, calib.zero_BR]
        self.code_to_corner = {}
        ecodes = evdev.ecodes.ecodes
        rev = {v: k for k, v in calib.axis_map.items()}
        for axis_name, corner in rev.items():
            if axis_name in ecodes:
                self.code_to_corner[ecodes[axis_name]] = corner
        self.corner_to_idx = {"TL": 0, "TR": 1, "BL": 2, "BR": 3}

    def update_from_event(self, event):
        if event.type != evdev.ecodes.EV_ABS:
            return
        corner = self.code_to_corner.get(event.code)
        if corner is None:
            return
        self.raw[self.corner_to_idx[corner]] = event.value


async def sensor_reader(dev, state):
    """Pump evdev events into shared state."""
    async for event in dev.async_read_loop():
        state.update_from_event(event)


async def broadcaster(state, clients):
    """Send normalized state to all connected clients at SAMPLE_HZ."""
    interval = 1.0 / SAMPLE_HZ
    while True:
        if clients:
            payload = json.dumps(compute_state(state.raw, state.calib))
            stale = []
            for ws in clients:
                try:
                    await ws.send(payload)
                except websockets.exceptions.ConnectionClosed:
                    stale.append(ws)
            for ws in stale:
                clients.discard(ws)
        await asyncio.sleep(interval)


async def serve(state):
    clients = set()

    async def handler(ws):
        clients.add(ws)
        print(f"  + client connected ({len(clients)} total)")
        try:
            async for _ in ws:  # we don't expect inbound messages, but keep the loop
                pass
        finally:
            clients.discard(ws)
            print(f"  - client disconnected ({len(clients)} remaining)")

    print(f"WebSocket listening on ws://{WS_HOST}:{WS_PORT}")
    async with websockets.serve(handler, WS_HOST, WS_PORT):
        await broadcaster(state, clients)


async def run(dev, calib):
    state = State(calib)
    await asyncio.gather(
        sensor_reader(dev, state),
        serve(state),
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe", action="store_true",
                        help="Print raw axis values to verify corner mapping.")
    parser.add_argument("--calibrate", action="store_true",
                        help="Capture zero baseline and body weight scale.")
    parser.add_argument("--device", default=None,
                        help="Override device path (e.g. /dev/input/event12).")
    args = parser.parse_args()

    if args.device:
        dev = evdev.InputDevice(args.device)
    else:
        dev = find_balance_board()
        if dev is None:
            print("ERROR: No balance board found.", file=sys.stderr)
            print("Pair it via bluetoothctl first. See README.md.", file=sys.stderr)
            print("\nDevices currently visible to evdev:", file=sys.stderr)
            for path in evdev.list_devices():
                try:
                    d = evdev.InputDevice(path)
                    print(f"  {path}: {d.name}", file=sys.stderr)
                except OSError:
                    pass
            sys.exit(1)

    print(f"Using {dev.path}: {dev.name}")

    if args.probe:
        probe(dev)
        return

    if args.calibrate:
        calibrate(dev)
        return

    calib = Calibration.load()
    if not CALIBRATION_FILE.exists():
        print("WARN: No calibration found, using defaults. Run --calibrate first.")

    try:
        asyncio.run(run(dev, calib))
    except KeyboardInterrupt:
        print("\nShutting down.")


if __name__ == "__main__":
    main()
