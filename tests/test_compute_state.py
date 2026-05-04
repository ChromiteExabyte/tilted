"""
Unit tests for balance_bridge.compute_state.

Mocks evdev and websockets so these run on any machine, not just the Linux
host with the board paired. No hardware required.
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock

sys.modules.setdefault("evdev", MagicMock())
sys.modules.setdefault("websockets", MagicMock())
sys.path.insert(0, str(Path(__file__).parent.parent / "bridge"))

from balance_bridge import Calibration, compute_state, MIN_TOTAL_KG  # noqa: E402

# raw order: [TL, TR, BL, BR]  (matches compute_state indexing)

DEFAULT = Calibration()  # all zeros, units_per_kg=100


def state(raw, calib=DEFAULT):
    return compute_state(raw, calib)


def even_raw(kg_per_corner, calib=DEFAULT):
    """Return raw values for equal weight on all four corners."""
    return [int(kg_per_corner * calib.units_per_kg)] * 4


# -----------------------------------------------------------------------------
# Presence
# -----------------------------------------------------------------------------

class TestPresence:
    def test_all_zero_is_absent(self):
        s = state([0, 0, 0, 0])
        assert not s["present"]
        assert s["cop_x"] == 0.0
        assert s["cop_y"] == 0.0
        assert s["total_kg"] == 0.0

    def test_just_below_threshold_is_absent(self):
        kg_total = MIN_TOTAL_KG - 0.1
        raw_each = int(kg_total * DEFAULT.units_per_kg / 4)
        s = state([raw_each] * 4)
        assert not s["present"]

    def test_exactly_at_threshold_is_present(self):
        # total < MIN_TOTAL_KG is absent; equal means present
        s = state(even_raw(MIN_TOTAL_KG / 4))
        assert s["present"]

    def test_well_above_threshold_is_present(self):
        s = state(even_raw(25))
        assert s["present"]


# -----------------------------------------------------------------------------
# Center of pressure
# -----------------------------------------------------------------------------

class TestCOP:
    def test_even_weight_cop_near_zero(self):
        s = state(even_raw(20))
        assert abs(s["cop_x"]) < 0.01
        assert abs(s["cop_y"]) < 0.01

    def test_all_weight_right_cop_x_is_plus_one(self):
        # TR and BR only → right=total, left=0 → cop_x = 1.0
        raw = [0, 5000, 0, 5000]
        s = state(raw)
        assert abs(s["cop_x"] - 1.0) < 0.01

    def test_all_weight_left_cop_x_is_minus_one(self):
        raw = [5000, 0, 5000, 0]
        s = state(raw)
        assert abs(s["cop_x"] + 1.0) < 0.01

    def test_right_tilt_positive_cop_x(self):
        # Right corners carry more → cop_x > 0
        raw = [2000, 8000, 2000, 8000]
        s = state(raw)
        assert s["cop_x"] > 0

    def test_left_tilt_negative_cop_x(self):
        raw = [8000, 2000, 8000, 2000]
        s = state(raw)
        assert s["cop_x"] < 0

    def test_all_weight_front_cop_y_is_plus_one(self):
        # TL and TR only → front=total, back=0 → cop_y = 1.0
        raw = [5000, 5000, 0, 0]
        s = state(raw)
        assert abs(s["cop_y"] - 1.0) < 0.01

    def test_all_weight_back_cop_y_is_minus_one(self):
        raw = [0, 0, 5000, 5000]
        s = state(raw)
        assert abs(s["cop_y"] + 1.0) < 0.01

    def test_forward_tilt_positive_cop_y(self):
        raw = [8000, 8000, 2000, 2000]
        s = state(raw)
        assert s["cop_y"] > 0

    def test_cop_within_bounds(self):
        import random
        rng = random.Random(0)
        for _ in range(50):
            raw = [rng.randint(1000, 9000) for _ in range(4)]
            s = state(raw)
            if s["present"]:
                assert -1.0 <= s["cop_x"] <= 1.0
                assert -1.0 <= s["cop_y"] <= 1.0


# -----------------------------------------------------------------------------
# Left / right shares
# -----------------------------------------------------------------------------

class TestShares:
    def test_even_shares(self):
        s = state(even_raw(20))
        assert abs(s["left_share"] - 0.5) < 0.01
        assert abs(s["right_share"] - 0.5) < 0.01

    def test_shares_sum_to_one(self):
        import random
        rng = random.Random(1)
        for _ in range(50):
            raw = [rng.randint(1000, 9000) for _ in range(4)]
            s = state(raw)
            if s["present"]:
                assert abs(s["left_share"] + s["right_share"] - 1.0) < 0.001

    def test_all_left_share(self):
        raw = [5000, 0, 5000, 0]
        s = state(raw)
        assert abs(s["left_share"] - 1.0) < 0.01
        assert abs(s["right_share"]) < 0.01

    def test_all_right_share(self):
        raw = [0, 5000, 0, 5000]
        s = state(raw)
        assert abs(s["right_share"] - 1.0) < 0.01
        assert abs(s["left_share"]) < 0.01


# -----------------------------------------------------------------------------
# Calibration offsets and scaling
# -----------------------------------------------------------------------------

class TestCalibration:
    def test_zero_offsets_subtracted(self):
        calib = Calibration(zero_TL=100, zero_TR=100, zero_BL=100, zero_BR=100,
                            units_per_kg=100.0)
        # raw exactly at offset → net 0 per corner → absent
        s = compute_state([100, 100, 100, 100], calib)
        assert not s["present"]

    def test_raw_below_offset_clamped_to_zero(self):
        # TL raw is below its offset; should not produce negative weight
        calib = Calibration(zero_TL=500, units_per_kg=100.0)
        raw = [0, 5000, 5000, 5000]
        s = compute_state(raw, calib)
        assert s["TL"] == 0.0
        assert s["TR"] > 0

    def test_units_per_kg_scaling(self):
        calib = Calibration(units_per_kg=200.0)  # 200 raw units per kg
        raw_each = 2000                           # → 10 kg per corner, 40 kg total
        s = compute_state([raw_each] * 4, calib)
        assert s["present"]
        assert abs(s["total_kg"] - 40.0) < 0.01

    def test_per_corner_kg_in_output(self):
        calib = Calibration(units_per_kg=100.0)
        raw = [1000, 2000, 3000, 4000]
        s = compute_state(raw, calib)
        assert abs(s["TL"] - 10.0) < 0.01
        assert abs(s["TR"] - 20.0) < 0.01
        assert abs(s["BL"] - 30.0) < 0.01
        assert abs(s["BR"] - 40.0) < 0.01

    def test_asymmetric_offsets(self):
        calib = Calibration(zero_TL=200, zero_TR=0, zero_BL=0, zero_BR=0,
                            units_per_kg=100.0)
        # TL is offset by 200 → net TL = (1200-200)/100 = 10; others = 10
        raw = [1200, 1000, 1000, 1000]
        s = compute_state(raw, calib)
        assert abs(s["TL"] - 10.0) < 0.01
        assert abs(s["TR"] - 10.0) < 0.01
