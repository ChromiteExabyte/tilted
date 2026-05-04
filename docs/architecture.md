# Architecture

## Why this shape

Two requirements drove the layout:

1. **Standing-desk friendly.** The Wii Remote / Wii Balance Board protocol is
   Bluetooth Classic HID — fast and reliable when a real OS Bluetooth stack
   handles it. Anything that puts a microcontroller (ESP32) between the board
   and the screen adds a second pairing step, more battery management, and
   more failure modes for no real win at the desk.
2. **Browser frontend, not native.** Leaflet + JS is the lingua franca for
   GIS portfolios; a Python desktop app or Electron wrapper would constrain
   future extension to just Leaflet replacements (e.g. MapLibre, OpenLayers).

So: a small Python bridge does the OS-level work (Bluetooth → evdev →
normalized JSON), the browser does the rest (gesture interpretation, map
rendering, game logic).

## Process boundaries

```
┌──────────────────────────────────────────────────────────────┐
│ Linux host                                                   │
│                                                              │
│  Wii Balance Board ──BT──▶ kernel hid-wiimote ──▶ /dev/inputN│
│                                                       │      │
│                                                       ▼      │
│                                            balance_bridge.py │
│                                            (evdev, asyncio)  │
│                                                       │      │
│                                            WebSocket :8765   │
│                                                       │      │
│                                                       ▼      │
│                                            Browser tab(s)    │
│                                            web/index.html    │
│                                            web/guesser.html  │
└──────────────────────────────────────────────────────────────┘
```

The bridge is intentionally dumb. It does:

- Pair-time identification of the board.
- Calibration: zero-baseline + per-user weight scale.
- Continuous evdev read, broadcast JSON at ~30 Hz.

It does **not**:

- Decide what counts as a "tilt" or a "leg raise."
- Track gesture state machines.
- Know anything about Leaflet.

Putting that logic in the browser means: anyone can rewrite the gesture
mapping in 50 lines of JS without touching the bridge. The bridge is a
sensor driver, full stop.

## Sample format

Each WebSocket frame is one JSON object:

| Field         | Type    | Meaning                                              |
| ------------- | ------- | ---------------------------------------------------- |
| `ts`          | float   | Unix timestamp, seconds                              |
| `present`     | bool    | True when total weight ≥ `MIN_TOTAL_KG` (default 15) |
| `total_kg`    | float   | Sum of all four sensors after calibration            |
| `TL TR BL BR` | float   | Per-corner weight in kg                              |
| `cop_x`       | float   | −1..+1, negative = left, positive = right            |
| `cop_y`       | float   | −1..+1, negative = back, positive = forward          |
| `left_share`  | float   | (TL+BL)/total                                        |
| `right_share` | float   | (TR+BR)/total                                        |

## Extending

- **Replace Leaflet with MapLibre.** Swap `web/index.html` and `web/js/map.js`.
  The bridge and gesture interpreter don't change.
- **Add Wii Remote support.** Wrap `find_balance_board()` in a more general
  device picker; the rest of the bridge already speaks evdev.
- **Multi-client.** The WebSocket already supports it. Open the map in two
  browser tabs and they'll move in sync.
- **Move the bridge to CottageBox.** Run `balance_bridge.py` on the Linux
  Mint host, expose port 8765 over Tailscale, browse from anywhere.
