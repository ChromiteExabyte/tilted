# balance-board-leaflet

Pan and zoom a Leaflet map by standing on a Wii Balance Board.
Standing-desk friendly. Linux host, browser frontend, no cloud.

Stretch mode: **BalanceGuessr** — GeoGuessr with satellite imagery instead of street view.

## Gesture map

| Action          | Gesture                                           |
| --------------- | ------------------------------------------------- |
| Pan             | Tilt body — center of pressure controls direction |
| Zoom in         | Lift left leg                                     |
| Zoom out        | Lift right leg                                    |
| Zoom speed      | Bob up and down while leg is raised               |
| Drop guess pin  | Both heels off, toes-only press (BalanceGuessr)   |
| Pause           | Step off                                          |

Mode discrimination is automatic: the bridge looks at how weight is distributed
across the four sensors and decides whether you're tilting (both feet down) or
zooming (one leg up). See `docs/gestures.md` for the math.

## Architecture

```
[Wii Balance Board] --BT--> [Linux kernel hid-wiimote]
                                      |
                                  evdev events
                                      |
                              bridge/balance_bridge.py
                                      |
                              WebSocket :8765
                                      |
                              web/ (Leaflet + JS)
```

No ESP32, no Dolphin, no cloud. One Python process, one browser tab.

## Quick start

### 1. Pair the board

```bash
sudo apt install bluetooth bluez python3-evdev
bluetoothctl
# In bluetoothctl:
#   power on
#   agent on
#   scan on
#   # Press the red sync button under the battery cover on the board
#   # A device named "Nintendo RVL-WBC-01" will appear
#   pair  XX:XX:XX:XX:XX:XX
#   trust XX:XX:XX:XX:XX:XX
#   connect XX:XX:XX:XX:XX:XX
#   quit
```

The kernel `hid-wiimote` driver claims the device automatically and exposes it
as an evdev node (typically `/dev/input/eventN`).

### 2. Run the bridge

```bash
cd bridge
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python balance_bridge.py --calibrate    # one-time, ~3 seconds standing still
python balance_bridge.py                # normal run
```

The bridge prints which evdev device it's reading and starts a WebSocket on
`ws://localhost:8765`.

### 3. Open the frontend

```bash
cd web
python3 -m http.server 8000
# Open http://localhost:8000 in your browser
```

For BalanceGuessr mode: `http://localhost:8000/guesser.html`.

## Status

- [x] Bridge: evdev reader, calibration, WebSocket server
- [x] Frontend: Leaflet map, pan/zoom from gestures, status overlay
- [x] BalanceGuessr: random Northern Ontario locations, distance scoring
- [ ] Tested on real hardware (your job — see `docs/calibration.md`)
- [ ] Foot outline calibration mat

## License

MIT. See `LICENSE`.
