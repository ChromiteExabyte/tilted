import { describe, expect, it } from "vitest";
import { GestureInterpreter } from "../src/gestures";
import type { BoardSample } from "../src/types";

/**
 * Synthesize a BoardSample with the same per-corner kg distribution the
 * Python bridge would produce. Defaults are 20 kg per corner (80 kg total,
 * even). Override individual fields to drive specific scenarios.
 */
function sample(overrides: Partial<BoardSample> = {}, ts = 0): BoardSample {
  const TL = overrides.TL ?? 20;
  const TR = overrides.TR ?? 20;
  const BL = overrides.BL ?? 20;
  const BR = overrides.BR ?? 20;
  const total = TL + TR + BL + BR;
  const left = TL + BL;
  const right = TR + BR;
  const front = TL + TR;
  const back = BL + BR;
  return {
    ts,
    present: total >= 15,
    total_kg: total,
    TL, TR, BL, BR,
    cop_x: total > 0 ? (right - left) / total : 0,
    cop_y: total > 0 ? (front - back) / total : 0,
    left_share: total > 0 ? left / total : 0,
    right_share: total > 0 ? right / total : 0,
    ...overrides,
  };
}

/**
 * Run the rezero phase to completion so the interpreter ends up in READY
 * with zero offsets (default centered samples). Most behavioral tests want
 * to skip past the calibration phase.
 */
function calibrate(g: GestureInterpreter, durationMs = 2000): number {
  const stride = 33; // ~30 Hz
  let t = 0;
  while (t <= durationMs) {
    g.onSample(sample({}, t / 1000));
    t += stride;
  }
  return t;
}

describe("classify / mode", () => {
  it("starts in ABSENT with no samples", () => {
    const g = new GestureInterpreter();
    expect(g.mode).toBe("ABSENT");
  });

  it("classifies even tilt as PAN", () => {
    const g = new GestureInterpreter();
    const t = calibrate(g);
    g.onSample(sample({ TL: 25, TR: 15, BL: 25, BR: 15 }, (t + 33) / 1000));
    expect(g.mode).toBe("PAN");
  });

  it("classifies left-leg-raised as ZOOM_IN", () => {
    const g = new GestureInterpreter();
    const t = calibrate(g);
    // Left side near zero → left_share < 0.15
    g.onSample(sample({ TL: 0.5, TR: 30, BL: 0.5, BR: 30 }, (t + 33) / 1000));
    expect(g.mode).toBe("ZOOM_IN");
  });

  it("classifies right-leg-raised as ZOOM_OUT", () => {
    const g = new GestureInterpreter();
    const t = calibrate(g);
    g.onSample(sample({ TL: 30, TR: 0.5, BL: 30, BR: 0.5 }, (t + 33) / 1000));
    expect(g.mode).toBe("ZOOM_OUT");
  });

  it("returns to ABSENT below MIN_TOTAL_KG", () => {
    const g = new GestureInterpreter();
    calibrate(g);
    g.onSample(sample({ TL: 0, TR: 0, BL: 0, BR: 0, present: false }, 5));
    expect(g.mode).toBe("ABSENT");
  });
});

describe("modechange events", () => {
  it("fires footon on first transition out of ABSENT", () => {
    const g = new GestureInterpreter();
    let footons = 0;
    g.addEventListener("footon", () => footons++);
    g.onSample(sample({}, 0));
    expect(footons).toBe(1);
  });

  it("fires footoff on transition to ABSENT", () => {
    const g = new GestureInterpreter();
    calibrate(g);
    let footoffs = 0;
    g.addEventListener("footoff", () => footoffs++);
    g.onSample(sample({ TL: 0, TR: 0, BL: 0, BR: 0, present: false }, 5));
    expect(footoffs).toBe(1);
  });

  it("emits modechange detail with from/to", () => {
    const g = new GestureInterpreter();
    calibrate(g);
    const transitions: { from: string; to: string }[] = [];
    g.addEventListener("modechange", (evt) => {
      transitions.push((evt as CustomEvent).detail);
    });
    // Even tilt → PAN
    g.onSample(sample({ TL: 25, TR: 15, BL: 25, BR: 15 }, 5));
    // Left lifted → ZOOM_IN
    g.onSample(sample({ TL: 0.5, TR: 30, BL: 0.5, BR: 30 }, 5.1));
    expect(transitions.at(-1)).toEqual({ from: "PAN", to: "ZOOM_IN" });
  });
});

describe("command — pan", () => {
  it("zero command in ABSENT", () => {
    const g = new GestureInterpreter();
    g.onSample(sample({ TL: 0, TR: 0, BL: 0, BR: 0, present: false }, 0));
    expect(g.command).toEqual({ panX: 0, panY: 0, zoom: 0, mode: "ABSENT" });
  });

  it("zero command inside deadzone", () => {
    const g = new GestureInterpreter();
    const t = calibrate(g);
    // Slight lean — cop_x of ~0.05 is below default deadzone 0.08
    g.onSample(sample({ TL: 21, TR: 19, BL: 21, BR: 19 }, (t + 33) / 1000));
    expect(g.command.panX).toBe(0);
    expect(g.command.panY).toBe(0);
    expect(g.command.mode).toBe("PAN");
  });

  it("pans right (positive panX) when leaning right", () => {
    const g = new GestureInterpreter();
    const t = calibrate(g);
    g.onSample(sample({ TL: 10, TR: 30, BL: 10, BR: 30 }, (t + 33) / 1000));
    expect(g.command.panX).toBeGreaterThan(0);
  });

  it("pans left when leaning left", () => {
    const g = new GestureInterpreter();
    const t = calibrate(g);
    g.onSample(sample({ TL: 30, TR: 10, BL: 30, BR: 10 }, (t + 33) / 1000));
    expect(g.command.panX).toBeLessThan(0);
  });

  it("forward lean drives panY negative (north on screen = up)", () => {
    const g = new GestureInterpreter();
    const t = calibrate(g);
    g.onSample(sample({ TL: 30, TR: 30, BL: 10, BR: 10 }, (t + 33) / 1000));
    expect(g.command.panY).toBeLessThan(0);
  });

  it("response is quadratic — bigger lean produces disproportionately bigger pan", () => {
    const g = new GestureInterpreter();
    const t = calibrate(g);
    // Small lean
    g.onSample(sample({ TL: 18, TR: 22, BL: 18, BR: 22 }, (t + 33) / 1000));
    const small = g.command.panX;
    // Larger lean (3x cop_x)
    g.onSample(sample({ TL: 12, TR: 28, BL: 12, BR: 28 }, (t + 66) / 1000));
    const large = g.command.panX;
    // Quadratic → ratio should be much greater than 3x
    expect(large / small).toBeGreaterThan(5);
  });
});

describe("command — zoom + bob", () => {
  it("ZOOM_IN produces positive zoom rate", () => {
    const g = new GestureInterpreter();
    const t = calibrate(g);
    g.onSample(sample({ TL: 0.5, TR: 30, BL: 0.5, BR: 30 }, (t + 33) / 1000));
    expect(g.command.zoom).toBeGreaterThan(0);
  });

  it("ZOOM_OUT produces negative zoom rate", () => {
    const g = new GestureInterpreter();
    const t = calibrate(g);
    g.onSample(sample({ TL: 30, TR: 0.5, BL: 30, BR: 0.5 }, (t + 33) / 1000));
    expect(g.command.zoom).toBeLessThan(0);
  });

  it("bobbing accelerates zoom rate vs steady stance", () => {
    const steady = new GestureInterpreter();
    const bobbing = new GestureInterpreter();
    const tA = calibrate(steady);
    const tB = calibrate(bobbing);

    // Both: left side near zero (ZOOM_IN), right side at 39.5 kg per corner =
    // total 80 kg. This matches calibration's total weight, so steady has
    // zero bob amplitude (calibration samples don't contaminate the rolling
    // window). Bobbing varies the right side ±5 kg.
    const samplesPerSec = 30;
    for (let i = 0; i < samplesPerSec; i++) {
      steady.onSample(
        sample({ TL: 0.5, TR: 39.5, BL: 0.5, BR: 39.5 }, (tA + i * 33) / 1000),
      );
      const wobble = Math.sin(i * 0.6) * 5;
      bobbing.onSample(
        sample(
          { TL: 0.5, TR: 39.5 + wobble, BL: 0.5, BR: 39.5 + wobble },
          (tB + i * 33) / 1000,
        ),
      );
    }
    expect(bobbing.command.zoom).toBeGreaterThan(steady.command.zoom);
  });
});

describe("inertia — tick()", () => {
  it("velocity approaches target command over successive ticks", () => {
    const g = new GestureInterpreter({ panInertiaMs: 100 });
    const t = calibrate(g);
    // Rightward lean in PAN mode: left_share=0.25 > threshold, cop_x=0.5 > deadzone
    g.onSample(sample({ TL: 10, TR: 30, BL: 10, BR: 30 }, (t + 33) / 1000));
    const target = g.command.panX;
    expect(target).toBeGreaterThan(0);

    // First tick: velocity should be partway toward target
    const first  = g.tick(0.033);
    // After ~3τ (300 ms) the velocity should be very close to target
    const after3tau = g.tick(0.300);

    expect(first.panX).toBeGreaterThan(0);
    expect(first.panX).toBeLessThan(target);
    // After ~3τ the filter is at ≥95% of target; check it's at least 90% (lenient for float dt).
    expect(after3tau.panX).toBeGreaterThan(target * 0.9);
  });

  it("velocity decays toward zero after board goes absent", () => {
    const g = new GestureInterpreter({ panInertiaMs: 100 });
    const t = calibrate(g);
    // Build up velocity with a lean
    g.onSample(sample({ TL: 5, TR: 35, BL: 5, BR: 35 }, (t + 33) / 1000));
    g.tick(0.300); // warm up — velocity near target

    // Board steps off → target becomes zero
    g.onSample(sample({ TL: 0, TR: 0, BL: 0, BR: 0, present: false }, (t + 400) / 1000));
    expect(g.command.panX).toBe(0); // instantaneous target is zero

    // One τ later — velocity should be well below what it was
    const decayed = g.tick(0.100); // dt = 1τ → α ≈ 0.63, vel ≈ 37% of peak
    const nearZero = g.tick(0.500); // another ~5τ → essentially zero
    expect(decayed.panX).toBeGreaterThanOrEqual(0); // still coasting (or snapped to 0)
    expect(nearZero.panX).toBe(0); // snapped by PAN_SNAP threshold
  });

  it("resetRezero zeroes velocity mid-glide", () => {
    const g = new GestureInterpreter({ panInertiaMs: 500 });
    const t = calibrate(g);
    g.onSample(sample({ TL: 5, TR: 35, BL: 5, BR: 35 }, (t + 33) / 1000));
    g.tick(0.300); // build velocity

    g.resetRezero();
    // After reset, next tick with dt=0 should yield zero velocity
    const after = g.tick(0);
    expect(after.panX).toBe(0);
    expect(after.panY).toBe(0);
    expect(after.zoom).toBe(0);
  });

  it("zoom velocity smooths over time", () => {
    const g = new GestureInterpreter({ zoomInertiaMs: 100 });
    const t = calibrate(g);
    // Left leg raised → ZOOM_IN
    g.onSample(sample({ TL: 0.5, TR: 30, BL: 0.5, BR: 30 }, (t + 33) / 1000));
    const targetZoom = g.command.zoom;
    expect(targetZoom).toBeGreaterThan(0);

    const first = g.tick(0.033);
    const later  = g.tick(0.300);
    expect(first.zoom).toBeGreaterThan(0);
    expect(first.zoom).toBeLessThan(targetZoom);
    expect(later.zoom).toBeGreaterThan(first.zoom);
  });
});

describe("session re-zero", () => {
  it("starts in DISCONNECTED, transitions to REZEROING on presence, then READY", () => {
    const g = new GestureInterpreter({ rezeroDurationMs: 1000 });
    const seen: string[] = [];
    g.addEventListener("statuschange", (evt) =>
      seen.push((evt as CustomEvent).detail.to),
    );
    // First present sample → REZEROING
    g.onSample(sample({}, 0));
    // Drive past the rezero duration
    for (let i = 33; i <= 1100; i += 33) {
      g.onSample(sample({}, i / 1000));
    }
    expect(seen).toEqual(["REZEROING", "READY"]);
    expect(g.status).toBe("READY");
  });

  it("captures non-zero offset when player has a consistent lean during calibration", () => {
    const g = new GestureInterpreter({ rezeroDurationMs: 1000 });
    // Slight rightward lean during the whole rezero window
    for (let i = 0; i <= 1100; i += 33) {
      g.onSample(sample({ TL: 18, TR: 22, BL: 18, BR: 22 }, i / 1000));
    }
    expect(g.status).toBe("READY");
    expect(g.rezeroOffset.x).toBeGreaterThan(0);
    expect(Math.abs(g.rezeroOffset.y)).toBeLessThan(0.01);
  });

  it("centers PAN response on the calibrated lean", () => {
    const g = new GestureInterpreter({ rezeroDurationMs: 1000 });
    // Calibrate with a rightward lean — that becomes the new "neutral"
    for (let i = 0; i <= 1100; i += 33) {
      g.onSample(sample({ TL: 18, TR: 22, BL: 18, BR: 22 }, i / 1000));
    }
    // Same lean again post-calibration → should be inside deadzone, no pan
    g.onSample(sample({ TL: 18, TR: 22, BL: 18, BR: 22 }, 1.2));
    expect(g.command.panX).toBe(0);
  });

  it("resetRezero clears offsets and goes back to DISCONNECTED", () => {
    const g = new GestureInterpreter({ rezeroDurationMs: 500 });
    for (let i = 0; i <= 600; i += 33) {
      g.onSample(sample({ TL: 18, TR: 22, BL: 18, BR: 22 }, i / 1000));
    }
    expect(g.status).toBe("READY");
    g.resetRezero();
    expect(g.status).toBe("DISCONNECTED");
    expect(g.rezeroOffset).toEqual({ x: 0, y: 0 });
  });
});
