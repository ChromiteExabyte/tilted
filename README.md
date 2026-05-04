# balance-board-leaflet

Pan and zoom a Leaflet map by standing on a Wii Balance Board.
Standing-desk friendly. Linux host for the bridge, browser frontend, no cloud.

Stretch mode: **BalanceGuessr** — GeoGuessr with satellite imagery instead of street view.

## Gesture map

| Action          | Gesture                                           |
| --------------- | ------------------------------------------------- |
| Pan             | Tilt body — center of pressure controls direction |
| Zoom in         | Lift left leg                                     |
| Zoom out        | Lift right leg                                    |
| Zoom speed      | Bob up and down while leg is raised               |
| Drop guess pin  | Both heels off, toes-only press (BalanceGuessr)   |
| Re-zero session | Press <kbd>R</kbd> on the keyboard                |
| Pause           | Step off                                          |

Mode discrimination is automatic: the bridge looks at how weight is distributed
across the four sensors and decides whether you're tilting (both feet down) or
zooming (one leg up). See `docs/gestures.md` for the math.

The first ~2 seconds of presence after page load are used to capture a per-session
COP offset so body asymmetry doesn't drift the map. Status flow: `DISCONNECTED →
REZEROING → READY`.

## Architecture

```
[Wii Balance Board] --BT--> [Linux kernel hid-wiimote]
                                      |
                                  evdev events
                                      |
                              bridge/balance_bridge.py    (Python, asyncio)
                                      |
                              WebSocket :8765
                                      |
                              web/ (Vite + TypeScript + Leaflet)
```

The bridge is a sensor driver — it does NOT know about gestures. Gesture
classification, mode discrimination, and command synthesis all happen in the
browser. Anyone can rewrite the gesture mapping without touching the bridge.

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

The kernel `hid-wiimote` driver claims the device and exposes it as an evdev
node (typically `/dev/input/eventN`).

### 2. Run the bridge

```bash
make install         # one-time: create venv, install deps
make calibrate       # one-time per board/user: zero baseline + body weight
make run             # start the WebSocket bridge on :8765
```

### 3. Run the web frontend

In a second terminal:

```bash
make web-install     # one-time: npm install
make dev             # Vite dev server on http://localhost:5173
```

Open `http://localhost:5173/` for the atlas, `http://localhost:5173/guesser.html`
for BalanceGuessr.

For a production bundle: `make build` → `web/dist/`, then `make preview` to
serve it. The dev keyboard fallback (arrow keys, +/-, G to advance, R to
re-zero) works without the board.

## Tests

```
make test            # bridge (pytest) + web (vitest), 46 tests total
make test-bridge     # just the Python sensor math
make test-web        # just the JS gesture interpreter
make typecheck       # tsc --noEmit
```

## Layout

```
bridge/              Python WebSocket bridge (Linux only)
docs/                Architecture, calibration, gesture math
tests/               Python tests (compute_state)
web/
  src/               TypeScript sources
    types.ts           BoardSample, PanZoomCommand, Mode, GestureStatus
    bridge-client.ts   WebSocket client with auto-reconnect
    gestures.ts        Mode classifier + session re-zero + command synth
    map.ts             Atlas mode entry point
    guesser.ts         BalanceGuessr entry point
    leaflet-setup.ts   Leaflet + bundled marker icons
    style.css          Shared field-instrument theme
    locations.json     15 Northern Ontario targets
  tests/             Vitest tests (gestures.test.ts)
  index.html         Vite entry — atlas
  guesser.html       Vite entry — BalanceGuessr
  vite.config.ts     Multi-page build + vitest config
  tsconfig.json      Strict TypeScript
Makefile             All commands (bridge + web)
```

## Status

- [x] Bridge: evdev reader, calibration, WebSocket server (Python, tested)
- [x] Frontend: Leaflet map, pan/zoom from gestures, status overlay
- [x] BalanceGuessr: random Northern Ontario locations, distance scoring
- [x] Per-session re-zero (DISCONNECTED → REZEROING → READY)
- [x] TypeScript with strict mode + Vitest unit tests
- [ ] Tested on real hardware (your job — see `docs/calibration.md`)
- [ ] Foot outline calibration mat

## License

MIT. See `LICENSE`.
