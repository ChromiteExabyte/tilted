VENV   := bridge/.venv
PYTHON := $(VENV)/bin/python
BRIDGE := bridge/balance_bridge.py

.PHONY: help install probe calibrate run web-install dev build preview test test-bridge test-web typecheck clean

help:
	@echo "balance-board-leaflet"
	@echo ""
	@echo "  Bridge (Linux host):"
	@echo "    make install       create venv, install bridge deps"
	@echo "    make probe         print live axis values"
	@echo "    make calibrate     capture zero baseline + body weight"
	@echo "    make run           start WebSocket bridge on :8765"
	@echo ""
	@echo "  Web (any host):"
	@echo "    make web-install   install npm deps"
	@echo "    make dev           Vite dev server"
	@echo "    make build         tsc + vite build → web/dist/"
	@echo "    make preview       serve a built bundle"
	@echo ""
	@echo "  Tests:"
	@echo "    make test          all (bridge + web)"
	@echo "    make test-bridge   pytest"
	@echo "    make test-web      vitest"
	@echo "    make typecheck     tsc --noEmit"

# ---- Bridge -----------------------------------------------------------------

install: $(VENV)

$(VENV): bridge/requirements.txt
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install -q -r bridge/requirements.txt

probe: $(VENV)
	$(PYTHON) $(BRIDGE) --probe

calibrate: $(VENV)
	$(PYTHON) $(BRIDGE) --calibrate

run: $(VENV)
	$(PYTHON) $(BRIDGE)

# ---- Web --------------------------------------------------------------------

web-install:
	cd web && npm install

dev:
	cd web && npm run dev

build:
	cd web && npm run build

preview:
	cd web && npm run preview

# ---- Tests ------------------------------------------------------------------

test: test-bridge test-web

test-bridge:
	python3 -m pytest tests/ -v

test-web:
	cd web && npm test

typecheck:
	cd web && npm run typecheck

clean:
	rm -rf web/dist web/node_modules/.vite
