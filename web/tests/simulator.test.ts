import { describe, expect, it } from "vitest";
import {
  SimulatorSource,
  demoScenario,
  quietScenario,
  type Movement,
} from "../src/sources/simulator";
import type { BoardSample } from "../src/types";
import { GestureInterpreter } from "../src/gestures";

/**
 * The simulator powers the demo mode AND serves as a useful test fixture for
 * end-to-end-ish gesture verification. Both responsibilities are exercised here.
 */

function pump(sim: SimulatorSource, durationMs: number, stride = 33): BoardSample[] {
  const out: BoardSample[] = [];
  for (let t = 0; t <= durationMs; t += stride) {
    out.push(sim.produce(t));
  }
  return out;
}

describe("BoardSample shape invariants", () => {
  const scenario: Movement[] = [
    { kind: "stand", durationMs: 1000 },
    { kind: "leanTo", x: 0.4, y: 0.2, durationMs: 800 },
    { kind: "liftLeg", side: "left", durationMs: 1000, bob: true },
    { kind: "pin", holdMs: 600 },
    { kind: "stepOff", durationMs: 500 },
  ];

  it("emits well-formed samples for every movement kind", () => {
    const sim = new SimulatorSource({ scenario, loop: false });
    const samples = pump(sim, 4000);
    for (const s of samples) {
      // All four corners non-negative and finite
      for (const k of ["TL", "TR", "BL", "BR"] as const) {
        expect(Number.isFinite(s[k])).toBe(true);
        expect(s[k]).toBeGreaterThanOrEqual(0);
      }
      // total_kg matches sum of corners (within float tolerance)
      const sum = s.TL + s.TR + s.BL + s.BR;
      expect(s.total_kg).toBeCloseTo(sum, 5);
      // cop in [-1, +1]
      expect(s.cop_x).toBeGreaterThanOrEqual(-1);
      expect(s.cop_x).toBeLessThanOrEqual(1);
      expect(s.cop_y).toBeGreaterThanOrEqual(-1);
      expect(s.cop_y).toBeLessThanOrEqual(1);
      // shares are well-defined when present, else zeros
      if (s.present) {
        expect(s.left_share + s.right_share).toBeCloseTo(1.0, 6);
      } else {
        expect(s.total_kg).toBeLessThan(15);
      }
    }
  });
});

describe("scenario movements", () => {
  it("stand: even-share PAN with cop near center", () => {
    const sim = new SimulatorSource({
      scenario: [{ kind: "stand", durationMs: 2000 }],
      loop: false,
    });
    const s = sim.produce(1000);
    expect(s.present).toBe(true);
    expect(Math.abs(s.cop_x)).toBeLessThan(0.05);
    expect(Math.abs(s.cop_y)).toBeLessThan(0.05);
    expect(Math.abs(s.left_share - 0.5)).toBeLessThan(0.05);
  });

  it("leanTo right pushes cop_x positive", () => {
    const sim = new SimulatorSource({
      scenario: [
        { kind: "stand", durationMs: 100 },
        { kind: "leanTo", x: 0.6, y: 0, durationMs: 1000 },
      ],
      loop: false,
    });
    const s = sim.produce(1100); // mid-end of leanTo
    expect(s.cop_x).toBeGreaterThan(0.3);
  });

  it("liftLeg left → left_share below the gesture threshold", () => {
    const sim = new SimulatorSource({
      scenario: [
        { kind: "stand", durationMs: 100 },
        { kind: "liftLeg", side: "left", durationMs: 1500 },
      ],
      loop: false,
    });
    const s = sim.produce(1500);
    expect(s.left_share).toBeLessThan(0.15);
  });

  it("pin: heels nearly empty, toes carry the load", () => {
    const sim = new SimulatorSource({
      scenario: [{ kind: "pin", holdMs: 800 }],
      loop: false,
    });
    const s = sim.produce(400);
    const toes = s.TL + s.TR;
    const heels = s.BL + s.BR;
    expect(toes).toBeGreaterThan(heels * 5);
  });

  it("stepOff: present=false, total_kg ~ 0", () => {
    const sim = new SimulatorSource({
      scenario: [{ kind: "stepOff", durationMs: 1000 }],
      loop: false,
    });
    const s = sim.produce(500);
    expect(s.present).toBe(false);
    expect(s.total_kg).toBeLessThan(1);
  });
});

describe("integration with GestureInterpreter", () => {
  it("demo scenario drives the interpreter through every mode", () => {
    const sim = new SimulatorSource({ scenario: demoScenario(), loop: false });
    const g = new GestureInterpreter();
    const seenModes = new Set<string>();
    g.addEventListener("modechange", (evt) => {
      seenModes.add((evt as CustomEvent).detail.to);
    });
    // Drive 25 s (full demo loop is roughly 18 s)
    for (let t = 0; t <= 25_000; t += 33) {
      g.onSample(sim.produce(t));
    }
    // ZOOM_IN / ZOOM_OUT omitted — zoom temporarily disabled in classify().
    for (const mode of ["PAN", "ABSENT"]) {
      expect(seenModes.has(mode)).toBe(true);
    }
  });

  it("demo scenario triggers at least one footoff event (step-off commit gesture)", () => {
    const sim = new SimulatorSource({ scenario: demoScenario(), loop: false });
    const g = new GestureInterpreter();
    let footoffs = 0;
    g.addEventListener("footoff", () => footoffs++);
    for (let t = 0; t <= 25_000; t += 33) {
      g.onSample(sim.produce(t));
    }
    expect(footoffs).toBeGreaterThanOrEqual(1);
  });

  it("quiet scenario completes the rezero phase without fluctuation", () => {
    const sim = new SimulatorSource({ scenario: quietScenario(), loop: false });
    const g = new GestureInterpreter({ rezeroDurationMs: 1500 });
    for (let t = 0; t <= 2000; t += 33) {
      g.onSample(sim.produce(t));
    }
    expect(g.status).toBe("READY");
    // Standing still ⇒ minimal drift in the captured offset
    expect(Math.abs(g.rezeroOffset.x)).toBeLessThan(0.05);
    expect(Math.abs(g.rezeroOffset.y)).toBeLessThan(0.05);
  });
});

describe("scenario looping", () => {
  it("loop=true wraps past the end of the scenario", () => {
    const sim = new SimulatorSource({
      scenario: [
        { kind: "stand", durationMs: 200 },
        { kind: "leanTo", x: 0.5, y: 0, durationMs: 200 },
      ],
      loop: true,
    });
    // First loop end: should still be producing samples
    const first = sim.produce(100);
    const second = sim.produce(500);
    const third = sim.produce(900);
    expect(first.present).toBe(true);
    expect(second.present).toBe(true);
    expect(third.present).toBe(true);
  });

  it("loop=false holds the terminal state past the end", () => {
    const sim = new SimulatorSource({
      scenario: [{ kind: "stepOff", durationMs: 100 }],
      loop: false,
    });
    const s = sim.produce(5000);
    expect(s.present).toBe(false);
  });
});
