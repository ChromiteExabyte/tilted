# bridge/

Reads the Wii Balance Board over Bluetooth and serves a normalized JSON
stream over WebSocket. Linux-only (uses kernel `hid-wiimote` + evdev).

## Setup

```bash
sudo apt install bluetooth bluez python3-venv
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

You may also need to add yourself to the `input` group so evdev is readable
without root:

```bash
sudo usermod -aG input $USER
# log out and back in
```

## Pair the board

The board's red sync button is under the battery cover on the underside.

```bash
bluetoothctl
power on
agent on
default-agent
scan on
# Press the sync button. Wait for "Nintendo RVL-WBC-01" or similar to appear.
pair  XX:XX:XX:XX:XX:XX
trust XX:XX:XX:XX:XX:XX
connect XX:XX:XX:XX:XX:XX
quit
```

The kernel binds the board automatically and exposes `/dev/input/eventN`.

## First run

```bash
# Step 1: verify which axis is which corner.
python balance_bridge.py --probe
# Press TL, TR, BL, BR in turn. Note which axis name changes.
# If the default mapping in DEFAULT_AXIS_MAP is wrong for your kernel,
# edit calibration.json after running --calibrate.

# Step 2: calibrate.
python balance_bridge.py --calibrate

# Step 3: run.
python balance_bridge.py
```

## Output format

JSON, one object per frame at 30 Hz:

```json
{
  "ts": 1714780000.123,
  "present": true,
  "total_kg": 78.4,
  "TL": 19.1, "TR": 20.0, "BL": 19.8, "BR": 19.5,
  "cop_x": 0.012,
  "cop_y": -0.003,
  "left_share": 0.498,
  "right_share": 0.502
}
```

`cop_x` and `cop_y` are in `[-1, +1]`. Negative x = left, positive y = forward.

## Troubleshooting

**"No balance board found"** — the kernel didn't bind it. Check `dmesg | tail`
for `hid-wiimote` messages. Try unpairing and re-pairing.

**Permission denied on `/dev/input/eventN`** — add yourself to the `input`
group, or run with `sudo` for testing.

**Board disconnects after a few seconds** — the board powers off if no
Bluetooth client is reading it. Make sure the bridge is running before the
board's idle timeout (about 10 seconds).

**Probe shows no axis movement** — the device might be a regular Wii Remote,
not the board. Check `dev.name` in the bridge output.
