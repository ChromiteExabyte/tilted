VENV   := bridge/.venv
PYTHON := $(VENV)/bin/python
BRIDGE := bridge/balance_bridge.py

.PHONY: help install probe calibrate run serve test

help:
	@echo "balance-board-leaflet"
	@echo ""
	@echo "  make install    create venv, install bridge deps"
	@echo "  make probe      print live axis values (verify corner mapping)"
	@echo "  make calibrate  capture zero baseline + body weight (run once)"
	@echo "  make run        start WebSocket bridge on :8765"
	@echo "  make serve      serve web/ on http://localhost:8000"
	@echo "  make test       run unit tests (no hardware required)"

# ---- Setup ------------------------------------------------------------------

install: $(VENV)

$(VENV): bridge/requirements.txt
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install -q -r bridge/requirements.txt

# ---- Hardware ---------------------------------------------------------------

probe: $(VENV)
	$(PYTHON) $(BRIDGE) --probe

calibrate: $(VENV)
	$(PYTHON) $(BRIDGE) --calibrate

run: $(VENV)
	$(PYTHON) $(BRIDGE)

# ---- Web frontend -----------------------------------------------------------

serve:
	cd web && python3 -m http.server 8000

# ---- Tests ------------------------------------------------------------------
# Uses system python3 so tests run on any dev machine, not just the Linux host.
# Requires: pip install pytest

test:
	python3 -m pytest tests/ -v
