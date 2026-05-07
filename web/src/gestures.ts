import type {
  BoardSample,
  GestureStatus,
  Mode,
  ModeChangeDetail,
  PanZoomCommand,
  StatusChangeDetail,
} from "./types";

export interface GestureOptions {
  deadzone?: number;
  legRaisedThreshold?: number;
  bobWindowMs?: number;
  bobMinAmpKg?: number;
  bobMaxAmpKg?: number;
  panGainPxPerSec?: number;
  zoomBaseRatePerSec?: number;
  zoomBobMultiplier?: number;
  rezeroDurationMs?: number;
  /** Exponential low-pass time constant for pan velocity (ms). Higher = more glide. */
  panInertiaMs?: number;
  /** Exponential low-pass time constant for zoom velocity (ms). Higher = more glide. */
  zoomInertiaMs?: number;
}

const DEFAULTS: Required<GestureOptions> = {
  deadzone: 0.08,
  legRaisedThreshold: 0.15,
  bobWindowMs: 1000,
  bobMinAmpKg: 1.5,
  bobMaxAmpKg: 8.0,
  panGainPxPerSec: 800,
  zoomBaseRatePerSec: 0.6,
  zoomBobMultiplier: 3.0,
  rezeroDurationMs: 2000,
  panInertiaMs: 250,
  zoomInertiaMs: 150,
};

const ZERO_COMMAND: PanZoomCommand = { panX: 0, panY: 0, zoom: 0, mode: "ABSENT" };

interface BobFrame {
  t: number;
  total: number;
}

/**
 * Translates BoardSample stream into discrete events (mode/status/pin) and a
 * continuous `command` field. Consumers read `command` at frame rate.
 *
 * Session re-zero: the first `rezeroDurationMs` of presence after construction
 * (or after `resetRezero()`) is averaged into a per-session COP offset that
 * compensates for body asymmetry. Status flows: DISCONNECTED → REZEROING → READY.
 */
export class GestureInterpreter extends EventTarget {
  readonly options: Required<GestureOptions>;

  mode: Mode = "ABSENT";
  status: GestureStatus = "DISCONNECTED";
  command: PanZoomCommand = { ...ZERO_COMMAND };
  lastSample: BoardSample | null = null;

  private bobHistory: BobFrame[] = [];

  /** Smoothed pan/zoom velocities updated by `tick()`. */
  private velPanX = 0;
  private velPanY = 0;
  private velZoom = 0;

  private rezeroAccumX = 0;
  private rezeroAccumY = 0;
  private rezeroSampleCount = 0;
  private rezeroStartedAtMs: number | null = null;
  private rezeroOffsetX = 0;
  private rezeroOffsetY = 0;

  constructor(opts: GestureOptions = {}) {
    super();
    this.options = { ...DEFAULTS, ...opts };
  }

  onSample(sample: BoardSample): void {
    this.lastSample = sample;
    const nowMs = sample.ts * 1000;

    this.updateStatusAndRezero(sample, nowMs);
    this.updateBobHistory(sample, nowMs);
    this.updateMode(sample);
    this.command = this.computeCommand(sample);
  }

  /** Discard session offsets and re-enter REZEROING on next presence. */
  resetRezero(): void {
    this.rezeroAccumX = 0;
    this.rezeroAccumY = 0;
    this.rezeroSampleCount = 0;
    this.rezeroStartedAtMs = null;
    this.rezeroOffsetX = 0;
    this.rezeroOffsetY = 0;
    this.velPanX = 0;
    this.velPanY = 0;
    this.velZoom = 0;
    this.transitionStatus("DISCONNECTED");
  }

  /**
   * Advance the inertia simulation by `dt` seconds and return the smoothed
   * command to apply this frame. Call this once per animation frame instead
   * of reading `command` directly.
   *
   * Implements an exponential low-pass filter:
   *   v += (target − v) × (1 − e^(−dt/τ))
   * so velocity glides toward the instantaneous target with time constant τ.
   */
  tick(dt: number): PanZoomCommand {
    const target = this.command;
    const τPan  = this.options.panInertiaMs  / 1000;
    const τZoom = this.options.zoomInertiaMs / 1000;
    const αPan  = 1 - Math.exp(-dt / τPan);
    const αZoom = 1 - Math.exp(-dt / τZoom);

    this.velPanX += (target.panX - this.velPanX) * αPan;
    this.velPanY += (target.panY - this.velPanY) * αPan;
    this.velZoom += (target.zoom - this.velZoom) * αZoom;

    // Snap sub-threshold velocities to zero to eliminate perpetual micro-drift.
    const PAN_SNAP  = 0.5;   // px/s
    const ZOOM_SNAP = 0.001; // levels/s
    return {
      panX: Math.abs(this.velPanX) < PAN_SNAP  ? 0 : this.velPanX,
      panY: Math.abs(this.velPanY) < PAN_SNAP  ? 0 : this.velPanY,
      zoom: Math.abs(this.velZoom) < ZOOM_SNAP ? 0 : this.velZoom,
      mode: target.mode,
    };
  }

  /** Current session COP offset (post-rezero correction applied to cop_x/cop_y). */
  get rezeroOffset(): { x: number; y: number } {
    return { x: this.rezeroOffsetX, y: this.rezeroOffsetY };
  }

  // ---------------------------------------------------------------------------
  // Status + per-session re-zero
  // ---------------------------------------------------------------------------

  private updateStatusAndRezero(sample: BoardSample, nowMs: number): void {
    if (!sample.present) {
      // Stepping off mid-rezero discards partial accumulation; offsets, if
      // already set, are preserved.
      if (this.status === "REZEROING") {
        this.rezeroAccumX = 0;
        this.rezeroAccumY = 0;
        this.rezeroSampleCount = 0;
        this.rezeroStartedAtMs = null;
        this.transitionStatus("DISCONNECTED");
      }
      return;
    }

    if (this.status === "DISCONNECTED" && this.rezeroSampleCount === 0 && this.rezeroOffsetX === 0 && this.rezeroOffsetY === 0) {
      this.rezeroStartedAtMs = nowMs;
      this.transitionStatus("REZEROING");
    }

    if (this.status === "REZEROING") {
      this.rezeroAccumX += sample.cop_x;
      this.rezeroAccumY += sample.cop_y;
      this.rezeroSampleCount += 1;

      const startedAt = this.rezeroStartedAtMs ?? nowMs;
      if (nowMs - startedAt >= this.options.rezeroDurationMs && this.rezeroSampleCount > 0) {
        this.rezeroOffsetX = this.rezeroAccumX / this.rezeroSampleCount;
        this.rezeroOffsetY = this.rezeroAccumY / this.rezeroSampleCount;
        this.transitionStatus("READY");
      }
    } else if (this.status === "DISCONNECTED") {
      // Offsets already locked in from a prior session — skip directly to READY.
      this.transitionStatus("READY");
    }
  }

  private transitionStatus(to: GestureStatus): void {
    if (to === this.status) return;
    const from = this.status;
    this.status = to;
    this.dispatchEvent(
      new CustomEvent<StatusChangeDetail>("statuschange", { detail: { from, to } }),
    );
  }

  // ---------------------------------------------------------------------------
  // Mode classification
  // ---------------------------------------------------------------------------

  private updateMode(sample: BoardSample): void {
    const next = this.classify(sample);
    if (next === this.mode) return;
    const from = this.mode;
    this.mode = next;
    if (from === "ABSENT") this.dispatchEvent(new Event("footon"));
    if (next === "ABSENT") this.dispatchEvent(new Event("footoff"));
    this.dispatchEvent(
      new CustomEvent<ModeChangeDetail>("modechange", { detail: { from, to: next } }),
    );
  }

  private classify(sample: BoardSample): Mode {
    if (!sample.present) return "ABSENT";
    if (sample.left_share < this.options.legRaisedThreshold) return "ZOOM_IN";
    if (sample.right_share < this.options.legRaisedThreshold) return "ZOOM_OUT";
    return "PAN";
  }

  // ---------------------------------------------------------------------------
  // Bob amplitude (rolling-window peak-to-trough on total weight)
  // ---------------------------------------------------------------------------

  private updateBobHistory(sample: BoardSample, nowMs: number): void {
    this.bobHistory.push({ t: nowMs, total: sample.total_kg });
    const cutoff = nowMs - this.options.bobWindowMs;
    while (this.bobHistory.length > 0 && this.bobHistory[0]!.t < cutoff) {
      this.bobHistory.shift();
    }
  }

  private bobAmplitude(): number {
    if (this.bobHistory.length < 4) return 0;
    let mn = Infinity;
    let mx = -Infinity;
    for (const { total } of this.bobHistory) {
      if (total < mn) mn = total;
      if (total > mx) mx = total;
    }
    return mx - mn;
  }

  private bobScale(): number {
    const amp = this.bobAmplitude();
    const { bobMinAmpKg, bobMaxAmpKg, zoomBobMultiplier } = this.options;
    if (amp <= bobMinAmpKg) return 1.0;
    const t = Math.min(1, (amp - bobMinAmpKg) / (bobMaxAmpKg - bobMinAmpKg));
    return 1.0 + t * (zoomBobMultiplier - 1.0);
  }

  // ---------------------------------------------------------------------------
  // Command computation
  // ---------------------------------------------------------------------------

  private computeCommand(sample: BoardSample): PanZoomCommand {
    if (this.mode === "ABSENT") return { ...ZERO_COMMAND };

    if (this.mode === "PAN") {
      const cx = sample.cop_x - this.rezeroOffsetX;
      const cy = sample.cop_y - this.rezeroOffsetY;
      const { deadzone, panGainPxPerSec } = this.options;
      const ax = Math.abs(cx) > deadzone ? cx - Math.sign(cx) * deadzone : 0;
      const ay = Math.abs(cy) > deadzone ? cy - Math.sign(cy) * deadzone : 0;
      // Quadratic response: fine control near center, accelerates with commitment.
      // cop_y positive = forward = pan north = negative pixel-y.
      // Explicit zero branches avoid -0 leaking into consumers.
      return {
        panX: ax === 0 ? 0 : Math.sign(ax) * ax * ax * panGainPxPerSec,
        panY: ay === 0 ? 0 : -Math.sign(ay) * ay * ay * panGainPxPerSec,
        zoom: 0,
        mode: "PAN",
      };
    }

    const dir = this.mode === "ZOOM_IN" ? 1 : -1;
    return {
      panX: 0,
      panY: 0,
      zoom: dir * this.options.zoomBaseRatePerSec * this.bobScale(),
      mode: this.mode,
    };
  }
}
