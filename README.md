# Tilted

> A full-stack project
> that turns a 2007 Wii peripheral into a precision map-navigation input
> device, with a GeoGuessr clone built on top. Demonstrates: WebHID device
> driver (TypeScript), real-time gesture classification, per-session sensor
> calibration, and a split-panel web game — all covered by a 95-test suite.
> Live demo requires no hardware (select **Demo** in the connection modal).

Pan and zoom a map by standing on a Wii Balance Board. Lean to steer,
lift a leg to zoom, bob to control speed. Includes **BalanceGuessr** —
a body-controlled GeoGuessr clone over Ontario satellite imagery.

Three connection modes — pick one from the in-page modal:

- **Demo (simulator)** — synthetic samples cycle through every gesture. No hardware needed; works on any browser, any OS.
- **Wii Balance Board (WebHID)** — direct browser → board on Chrome/Edge. Pair the board in OS Bluetooth, click Connect, no Python bridge required.
- **Bridge server (WebSocket)** — connects to `balance_bridge.py` running on a Linux host (the original path).

Your choice persists in localStorage. Click the connection pill in the topbar to change it.

The map renderer happens to be Leaflet, but that's an implementation
detail — the gesture pipeline and source abstraction don't depend on it.

## Gesture map

| Action                  | Gesture                                           |
| ----------------------- | ------------------------------------------------- |
| Pan                     | Tilt body — center of pressure controls direction |
| Zoom in                 | Lift left leg                                     |
| Zoom out                | Lift right leg                                    |
| Zoom speed              | Bob up and down while leg is raised               |
| Advance (BalanceGuessr) | **Step off** — exits STUDY → GUESS, or commits GUESS → REVEAL |
| Acknowledge result      | **Step back on** — advances REVEAL → next round / SUMMARY → new game |
| Cancel guess            | Press <kbd>Esc</kbd> to return to STUDY mid-round |
| Re-zero session         | Press <kbd>R</kbd> on the keyboard                |
| Pause (Atlas)           | Step off                                          |

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

## Try it without hardware (90 seconds)

```bash
cd web
npm install
npm run dev
```

Open `http://localhost:5173/`, pick **Demo (simulator)** in the modal. The COP
dot and gesture mode will animate through every state — pan, zoom, leg-lifts,
pin gestures — so you can see the whole UI working without a board.

## Connect a real board (Chrome / Edge)

1. Pair the board via your OS Bluetooth settings (the red sync button is under
   the battery cover).
2. `npm run dev`, open the page, pick **Wii Balance Board (WebHID)**.
3. Browser shows a device picker → select "Nintendo RVL-WBC-01" → done.

The WebHID driver lives in [`web/src/sources/webhid.ts`](web/src/sources/webhid.ts).
It has been validated against a real Nintendo RVL-WBC-01. One non-obvious
finding: the `0x21` read-reply byte encodes `size−1` in the HIGH nibble and
`error` in the LOW nibble — opposite to what the WiiBrew wiki documents. The
correct Balance Board init is a single write of `0x00` to `0xa40040` (old-style);
the Motion Plus "new-style" init does not apply.

## Original Linux/bridge path

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
make test            # bridge (pytest) + web (vitest), 95 tests total
make test-bridge     # Python sensor math (22 tests)
make test-web        # gestures, scoring, simulator, websocket source, conn-pill wiring (73 tests)
make typecheck       # tsc --noEmit
```

The simulator doubles as a test fixture: scripted scenarios drive the gesture
interpreter through every mode without needing a board, so the full sample →
gesture → command pipeline is covered.

## Layout

```
bridge/              Python WebSocket bridge (Linux only)
docs/                Architecture, calibration, gesture math
tests/               Python tests (compute_state)
web/
  src/               TypeScript sources
    types.ts           BoardSample, PanZoomCommand, Mode, GestureStatus
    sources/           Sample-source abstraction
      types.ts           SampleSource interface, SourceStatus
      base.ts            Shared status/event-dispatch base class
      websocket.ts       Bridge-server source (WebSocket → balance_bridge.py)
      simulator.ts       Synthetic-sample source (demo / test fixture)
      webhid.ts          Direct browser-to-board source via WebHID
      factory.ts         createSource(), localStorage helpers
      picker.ts          Connection-picker modal UI
      index.ts           Re-exports
    gestures.ts        Mode classifier + session re-zero + command synth
    scoring.ts         Haversine + score curve + shuffle (BalanceGuessr)
    map.ts             Atlas mode entry point
    guesser.ts         BalanceGuessr entry point
    leaflet-setup.ts   Leaflet + bundled marker icons
    style.css          Shared field-instrument theme
    locations.json     35 Ontario targets
  tests/             Vitest suites
    gestures.test.ts   Mode/command/pin/re-zero — 24 tests
    scoring.test.ts    Haversine + score + shuffle + best-score persistence — 26 tests
    simulator.test.ts  Sample shape + scenario integration — 11 tests
    websocket.test.ts  Bridge source: connect, JSON parse, reconnect backoff, stop — 8 tests
    wiring.test.ts     Conn-pill button binding — 4 tests
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
- [x] Source abstraction: simulator / WebHID / bridge, picker UI, persisted choice
- [ ] Console / terminal to get output data -- the Wii board is painful to connnect to bluetooth at present. 
- [x] WebHID validated against a real Balance Board
- [ ] Bridge tested on real hardware (your job — see `docs/calibration.md`)
- [ ] Foot outline calibration mat

## License

MIT. See `LICENSE`.
