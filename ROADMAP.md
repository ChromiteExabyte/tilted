# Roadmap

Items marked ✅ are shipped. Items marked 🔲 are planned or in progress.

## Core infrastructure

- ✅ Python WebSocket bridge — evdev reader, calibration, server
- ✅ Source abstraction — `SampleSource` interface, factory, picker modal
- ✅ WebHID direct-browser driver (protocol written, awaits real-hardware validation)
- ✅ Demo simulator — scripted gesture scenarios, useful as a test fixture
- ✅ Per-session re-zero (DISCONNECTED → REZEROING → READY)
- ✅ Frame-dt clamp — prevents tab-resume map jumps
- ✅ TypeScript strict mode + Vitest unit tests (95 tests)

## Atlas mode

- ✅ Leaflet map, pan / zoom from gestures
- ✅ Quadratic pan response — fine near center, fast at edges
- ✅ Pan + zoom inertia — exponential low-pass filter (`tick(dt)` API, τ≈250ms pan / 150ms zoom)
- ✅ Bob-scaling for zoom speed
- ✅ COP indicator with rezero progress overlay
- 🔲 Keyboard-shortcut cheat-sheet overlay (toggle with `?`)
- 🔲 Persist last view in `localStorage` (zoom + center)

## BalanceGuessr

- ✅ 35 Ontario locations with hints
- ✅ Haversine distance scoring (5000 · e^{−km/250})
- ✅ Random map rotation on study view (GeoGuessr-style disorientation)
- ✅ Step-off-board commit gesture (step off = advance; step on = acknowledge)
- ✅ Per-game best score persistence
- ✅ Escape key cancels a guess mid-round
- 🔲 Expand to 100+ locations across Canada
- 🔲 Difficulty tiers (street-level vs province-level zoom)
- 🔲 Shareable results card (score + map thumbnail)

## Connection UX

- ✅ Persistent source preference (localStorage)
- ✅ Descriptive error messages surface in the picker
- 🔲 Animated Bluetooth pairing walkthrough for WebHID first-timers
- 🔲 Three named modes in the picker: **Explore** (atlas), **BalanceGuessr**, **Demo**
- 🔲 Reconnect indicator with visual pulse when bridge drops

## Hardware

- ✅ Validate WebHID path against a real Balance Board end-to-end
- 🔲 Foot-outline calibration mat template (PDF) for repeatable placement
- 🔲 Axis-mapping auto-probe (surface `--probe` output in the picker)

## Portfolio / DX

- ✅ Repo renamed to reflect the project, not the library dependency
- ✅ Portfolio paragraph in README
- ✅ Docs updated to reflect implemented state (rezero, commit gesture)
- 🔲 GitHub Pages deploy of the demo (simulator mode, no server needed)
- 🔲 CI: GitHub Actions running `make test` + `make typecheck` on push
