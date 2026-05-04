// gestures.js — interprets balance board samples into pan/zoom velocity + events.
//
// Modes:
//   ABSENT  — total weight too low; nothing happens
//   PAN     — both feet down; tilt drives pan velocity
//   ZOOM_IN — left leg raised; zoom in, speed scaled by bob amplitude
//   ZOOM_OUT — right leg raised; zoom out, speed scaled by bob amplitude
//
// Discrete events:
//   "footon"   — fired when transitioning from ABSENT to any active mode
//   "footoff"  — fired when transitioning to ABSENT
//   "modechange" — fired when transitioning between PAN and ZOOM_*
//   "guesspin" — fired when both heels off, toes-only press (BalanceGuessr)
//
// Tunables in DEFAULTS — exposed via constructor opts.

(function (global) {
  "use strict";

  const DEFAULTS = {
    deadzone: 0.08,
    legRaisedThreshold: 0.15,
    bobWindowMs: 1000,
    bobMinAmpKg: 1.5,
    bobMaxAmpKg: 8.0,
    panGainPxPerSec: 800,        // map pixels per second at full tilt
    zoomBaseRatePerSec: 0.6,     // zoom levels per second when leg is raised
    zoomBobMultiplier: 3.0,      // scale factor at full bob amplitude
    pinTrigger: {
      heelMaxKg: 1.0,
      toeMinKg: 6.0,
      holdMs: 600,
    },
  };

  class GestureInterpreter extends EventTarget {
    constructor(opts = {}) {
      super();
      this.opts = { ...DEFAULTS, ...opts };
      this.mode = "ABSENT";
      this.totalHistory = []; // {t, total}
      this.lastSample = null;
      this.pinHoldStart = null;
    }

    onSample(sample) {
      this.lastSample = sample;
      const now = sample.ts * 1000;

      // Maintain rolling weight history for bob detection
      this.totalHistory.push({ t: now, total: sample.total_kg });
      const cutoff = now - this.opts.bobWindowMs;
      while (this.totalHistory.length && this.totalHistory[0].t < cutoff) {
        this.totalHistory.shift();
      }

      const newMode = this._classify(sample);
      if (newMode !== this.mode) {
        const prev = this.mode;
        this.mode = newMode;
        if (prev === "ABSENT") this._emit("footon");
        if (newMode === "ABSENT") this._emit("footoff");
        this._emit("modechange", { from: prev, to: newMode });
      }

      this._checkPinGesture(sample, now);

      const cmd = this._command(sample);
      this._emit("command", cmd);
    }

    _classify(sample) {
      // left_share low ⇒ weight on the right side ⇒ left leg raised.
      // Per spec: left leg up = zoom IN, right leg up = zoom OUT.
      if (!sample.present) return "ABSENT";
      if (sample.left_share < this.opts.legRaisedThreshold) return "ZOOM_IN";
      if (sample.right_share < this.opts.legRaisedThreshold) return "ZOOM_OUT";
      return "PAN";
    }

    _bobAmplitude() {
      if (this.totalHistory.length < 4) return 0;
      let mn = Infinity, mx = -Infinity;
      for (const { total } of this.totalHistory) {
        if (total < mn) mn = total;
        if (total > mx) mx = total;
      }
      return mx - mn;
    }

    _bobScale() {
      const amp = this._bobAmplitude();
      const { bobMinAmpKg, bobMaxAmpKg, zoomBobMultiplier } = this.opts;
      if (amp <= bobMinAmpKg) return 1.0;
      const t = Math.min(1, (amp - bobMinAmpKg) / (bobMaxAmpKg - bobMinAmpKg));
      return 1.0 + t * (zoomBobMultiplier - 1.0);
    }

    _command(sample) {
      const cmd = { panX: 0, panY: 0, zoom: 0, mode: this.mode };
      if (this.mode === "PAN") {
        const { deadzone, panGainPxPerSec } = this.opts;
        const ax = Math.abs(sample.cop_x) > deadzone
          ? sample.cop_x - Math.sign(sample.cop_x) * deadzone : 0;
        const ay = Math.abs(sample.cop_y) > deadzone
          ? sample.cop_y - Math.sign(sample.cop_y) * deadzone : 0;
        // Quadratic response feels more controllable than linear
        cmd.panX = Math.sign(ax) * ax * ax * panGainPxPerSec;
        // cop_y positive = forward = pan north (up on screen, negative y)
        cmd.panY = -Math.sign(ay) * ay * ay * panGainPxPerSec;
      } else if (this.mode === "ZOOM_IN" || this.mode === "ZOOM_OUT") {
        const dir = this.mode === "ZOOM_IN" ? 1 : -1;
        cmd.zoom = dir * this.opts.zoomBaseRatePerSec * this._bobScale();
      }
      return cmd;
    }

    _checkPinGesture(sample, now) {
      // Toes-only press: BL+BR are heels, TL+TR are toes.
      if (!sample.present) {
        this.pinHoldStart = null;
        return;
      }
      const heels = sample.BL + sample.BR;
      const toes = sample.TL + sample.TR;
      const cfg = this.opts.pinTrigger;
      const holding = heels < cfg.heelMaxKg && toes > cfg.toeMinKg;
      if (!holding) {
        this.pinHoldStart = null;
        return;
      }
      if (this.pinHoldStart === null) {
        this.pinHoldStart = now;
        return;
      }
      if (now - this.pinHoldStart >= cfg.holdMs) {
        this.pinHoldStart = null; // require release before re-trigger
        this._emit("guesspin");
      }
    }

    _emit(type, detail) {
      this.dispatchEvent(new CustomEvent(type, { detail }));
    }
  }

  global.GestureInterpreter = GestureInterpreter;
})(window);
