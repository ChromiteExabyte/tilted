import type { BoardSample } from "../types";
import { BaseSampleSource } from "./base";
import type { SourceId } from "./types";

/** A scripted body movement. Durations are milliseconds. */
export type Movement =
  /** Stand still (optionally with a small consistent lean to test re-zero). */
  | { kind: "stand"; durationMs: number; lean?: { x: number; y: number } }
  /** Smoothly move COP from current to a target inside [-1, +1]^2. */
  | { kind: "leanTo"; x: number; y: number; durationMs: number }
  /** Lift one leg (the other side carries ~all the weight). Optionally bob. */
  | { kind: "liftLeg"; side: "left" | "right"; durationMs: number; bob?: boolean }
  /** Toes-only press for a held duration (BalanceGuessr pin gesture). */
  | { kind: "pin"; holdMs: number }
  /** Step off the board (no presence). */
  | { kind: "stepOff"; durationMs: number };

export interface SimulatorOptions {
  /** Sample emission rate. The bridge emits ~30 Hz, default matches. */
  sampleHz?: number;
  /** Body weight in kg (drives total_kg when on the board). */
  bodyKg?: number;
  /** Loop the scenario indefinitely. */
  loop?: boolean;
  /** Optional clock injection for deterministic tests. Default: performance.now(). */
  now?: () => number;
  /** Scenario script. Defaults to `demoScenario()` — tour of all gestures. */
  scenario?: Movement[];
}

/**
 * A realistic-feeling tour of every gesture the interpreter understands.
 * Loops indefinitely by default so you can leave the page open and watch
 * the UI react.
 */
export function demoScenario(): Movement[] {
  return [
    { kind: "stand", durationMs: 2200 }, // gives the rezero phase enough time
    { kind: "leanTo", x: 0.45, y: 0, durationMs: 1500 },
    { kind: "leanTo", x: 0, y: 0, durationMs: 800 },
    { kind: "leanTo", x: -0.45, y: 0, durationMs: 1500 },
    { kind: "leanTo", x: 0, y: 0.55, durationMs: 1500 },
    { kind: "leanTo", x: 0, y: -0.45, durationMs: 1500 },
    { kind: "leanTo", x: 0, y: 0, durationMs: 600 },
    { kind: "liftLeg", side: "left", durationMs: 2000, bob: true },
    { kind: "stand", durationMs: 700 },
    { kind: "liftLeg", side: "right", durationMs: 1800, bob: false },
    { kind: "stand", durationMs: 900 },
    { kind: "pin", holdMs: 800 },
    { kind: "stand", durationMs: 1200 },
    { kind: "stepOff", durationMs: 1200 },
  ];
}

/** Stand still, no lean. Useful for tests that don't care about motion. */
export function quietScenario(): Movement[] {
  return [{ kind: "stand", durationMs: 60_000 }];
}

/**
 * Synthesizes BoardSample frames from a scripted scenario. Replaces a
 * physical board for demos and end-to-end-ish tests. The math is intentionally
 * cartoonish — the goal is "looks like a person on a board," not biomechanics.
 */
export class SimulatorSource extends BaseSampleSource {
  readonly id: SourceId = "simulator";
  readonly displayName = "Demo (simulator)";

  private readonly sampleHz: number;
  private readonly bodyKg: number;
  private readonly loop: boolean;
  private readonly now: () => number;
  private readonly scenario: Movement[];

  private timer: number | null = null;
  private startedAt = 0;
  private cursor = 0; // index into scenario
  private cursorStart = 0; // wall-clock ms when current movement began
  private prevLean = { x: 0, y: 0 };
  private currentLean = { x: 0, y: 0 };
  private bobPhase = 0;
  private stopped = false;

  constructor(opts: SimulatorOptions = {}) {
    super();
    this.sampleHz = opts.sampleHz ?? 30;
    this.bodyKg = opts.bodyKg ?? 78;
    this.loop = opts.loop ?? true;
    this.now = opts.now ?? (() => performance.now());
    this.scenario = opts.scenario ?? demoScenario();
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.cursor = 0;
    this.startedAt = this.now();
    this.cursorStart = this.startedAt;
    this.prevLean = { x: 0, y: 0 };
    this.currentLean = { x: 0, y: 0 };
    this.setStatus("connected", "demo running");
    const intervalMs = 1000 / this.sampleHz;
    this.timer = window.setInterval(() => this.tick(), intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.setStatus("disconnected");
  }

  /**
   * Public for tests — produces one sample at virtual time `tMs` from start.
   * Does not advance any internal timing state.
   */
  produce(tMs: number): BoardSample {
    return this.computeSample(tMs);
  }

  private tick(): void {
    if (this.stopped) return;
    const sample = this.computeSample(this.now() - this.startedAt);
    this.emitSample(sample);
  }

  private computeSample(tMs: number): BoardSample {
    const move = this.advanceCursor(tMs);
    const local = tMs - this.cursorStart;
    const t = clamp(local / Math.max(1, this.movementDuration(move)), 0, 1);

    let cop = { x: 0, y: 0 };
    let weightFactor = 1; // 1 = full body weight on board, 0 = stepped off
    let leftShareOverride: number | null = null;
    let toesHeavy = false;

    switch (move.kind) {
      case "stand":
        cop = move.lean ?? { x: 0, y: 0 };
        weightFactor = 1;
        break;
      case "leanTo": {
        const target = { x: move.x, y: move.y };
        cop = lerpVec(this.prevLean, target, easeInOut(t));
        if (t >= 1) this.currentLean = target;
        weightFactor = 1;
        break;
      }
      case "liftLeg": {
        // Smoothly transfer weight to the planted side; left_share or right_share
        // drops below the 0.15 threshold to trigger ZOOM_IN/ZOOM_OUT mode.
        const targetShare = 0.05; // tiny remaining weight on raised side
        const ramp = easeInOut(Math.min(1, t * 2)); // reach the target in the first half
        leftShareOverride =
          move.side === "left"
            ? lerp(0.5, targetShare, ramp)
            : lerp(0.5, 1 - targetShare, ramp);
        if (move.bob) {
          const wobble = 0.06 * Math.sin(this.bobPhase);
          this.bobPhase += 0.45;
          weightFactor = 1 + wobble;
        } else {
          weightFactor = 1;
        }
        break;
      }
      case "pin":
        toesHeavy = true;
        weightFactor = 1;
        break;
      case "stepOff":
        weightFactor = 0;
        break;
    }

    const ts = (this.startedAt + tMs) / 1000;
    return composeSample({
      ts,
      cop,
      weightFactor,
      bodyKg: this.bodyKg,
      leftShareOverride,
      toesHeavy,
    });
  }

  private advanceCursor(tMs: number): Movement {
    while (true) {
      const move = this.scenario[this.cursor];
      if (!move) {
        // Past the end of the scenario.
        if (this.loop) {
          this.cursor = 0;
          this.cursorStart = tMs;
          continue;
        }
        // Hold the last movement's terminal state (or stepOff if nothing).
        return this.scenario.at(-1) ?? { kind: "stepOff", durationMs: 1000 };
      }
      const dur = this.movementDuration(move);
      if (tMs - this.cursorStart < dur) return move;
      // Move ended — advance and persist any state needed for the next.
      this.prevLean = move.kind === "leanTo" ? { x: move.x, y: move.y } : this.currentLean;
      this.cursor += 1;
      this.cursorStart += dur;
    }
  }

  private movementDuration(move: Movement): number {
    return move.kind === "pin" ? move.holdMs : move.durationMs;
  }
}

// -----------------------------------------------------------------------------
// Sample composition — turn (cop, weight, overrides) into a full BoardSample
// -----------------------------------------------------------------------------

interface ComposeArgs {
  ts: number;
  cop: { x: number; y: number };
  weightFactor: number;
  bodyKg: number;
  leftShareOverride: number | null;
  toesHeavy: boolean;
}

function composeSample(args: ComposeArgs): BoardSample {
  const total = args.bodyKg * args.weightFactor;
  if (total < 0.5) {
    return zeroSample(args.ts);
  }

  const cx = clamp(args.cop.x, -1, 1);
  const cy = clamp(args.cop.y, -1, 1);
  const leftShare = args.leftShareOverride ?? 0.5 - cx / 2;
  const rightShare = 1 - leftShare;
  const frontShare = args.toesHeavy ? 0.99 : 0.5 + cy / 2;
  const backShare = 1 - frontShare;

  // Distribute total across four corners so that left/right and front/back
  // shares match. Each corner gets total * (leftOrRight) * (frontOrBack).
  let TL = total * leftShare * frontShare;
  let TR = total * rightShare * frontShare;
  let BL = total * leftShare * backShare;
  let BR = total * rightShare * backShare;

  // Re-derive cop from the actual corner distribution so per-corner kg and
  // cop_x/y stay self-consistent (the gesture interpreter relies on this).
  const left = TL + BL;
  const right = TR + BR;
  const front = TL + TR;
  const back = BL + BR;
  const cop_x = (right - left) / total;
  const cop_y = (front - back) / total;

  return {
    ts: args.ts,
    present: total >= 15,
    total_kg: total,
    TL, TR, BL, BR,
    cop_x,
    cop_y,
    left_share: left / total,
    right_share: right / total,
  };
}

function zeroSample(ts: number): BoardSample {
  return {
    ts,
    present: false,
    total_kg: 0,
    TL: 0, TR: 0, BL: 0, BR: 0,
    cop_x: 0, cop_y: 0,
    left_share: 0, right_share: 0,
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpVec = (a: { x: number; y: number }, b: { x: number; y: number }, t: number) => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
});
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
