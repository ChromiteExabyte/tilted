import { L } from "./leaflet-setup";
import { BridgeClient } from "./bridge-client";
import { GestureInterpreter } from "./gestures";
import type { BoardSample, GestureStatus, ModeChangeDetail, StatusChangeDetail } from "./types";
import "./style.css";

const DEFAULT_CENTER: L.LatLngTuple = [49.0639, -81.0167]; // Cochrane, ON
const DEFAULT_ZOOM = 6;
const ZOOM_MIN = 2;
const ZOOM_MAX = 19;

const map = L.map("map", {
  center: DEFAULT_CENTER,
  zoom: DEFAULT_ZOOM,
  zoomControl: false,
  zoomSnap: 0,
  zoomDelta: 0.05,
  wheelDebounceTime: 40,
  inertia: false,
});

const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "© OpenStreetMap",
});
const sat = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: 19,
    attribution:
      "Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, GIS User Community",
  },
);
sat.addTo(map);

L.control.layers({ Satellite: sat, OpenStreetMap: osm }, undefined, { position: "topright" }).addTo(map);

// ---- HUD wiring -------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

const statusEl = $("status");
const modeEl = $("mode");
const phaseEl = $("phase");
const weightEl = $("weight");
const copDot = $("cop-dot");
const connEl = $("conn");

const PHASE_LABELS: Record<GestureStatus, string> = {
  DISCONNECTED: "—",
  REZEROING: "calibrating…",
  READY: "ready",
};

const setPhase = (status: GestureStatus): void => {
  phaseEl.textContent = PHASE_LABELS[status];
  statusEl.dataset.status = status;
};

// ---- Bridge + gestures ------------------------------------------------------

const bridge = new BridgeClient();
const gestures = new GestureInterpreter();

bridge.addEventListener("open", () => {
  connEl.textContent = "● connected";
  connEl.classList.add("ok");
});
bridge.addEventListener("close", () => {
  connEl.textContent = "○ reconnecting";
  connEl.classList.remove("ok");
});

bridge.addEventListener("sample", (evt) => {
  const sample = (evt as CustomEvent<BoardSample>).detail;
  gestures.onSample(sample);

  weightEl.textContent = sample.present ? `${sample.total_kg.toFixed(1)} kg` : "—";

  // COP -1..+1 → 0..100% (after applying the session offset so the dot
  // visually centers when the player is at their natural standing posture).
  const offset = gestures.rezeroOffset;
  const cx = sample.cop_x - offset.x;
  const cy = sample.cop_y - offset.y;
  copDot.style.left = `${((cx + 1) / 2) * 100}%`;
  copDot.style.top = `${((1 - cy) / 2) * 100}%`;
  copDot.classList.toggle("active", sample.present);
});

gestures.addEventListener("modechange", (evt) => {
  const detail = (evt as CustomEvent<ModeChangeDetail>).detail;
  modeEl.textContent = detail.to;
  statusEl.dataset.mode = detail.to;
});
gestures.addEventListener("statuschange", (evt) => {
  setPhase((evt as CustomEvent<StatusChangeDetail>).detail.to);
});
setPhase(gestures.status);

// ---- Frame-rate command application -----------------------------------------

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

let lastT = performance.now();
const tick = (now: number): void => {
  const dt = (now - lastT) / 1000;
  lastT = now;
  const cmd = gestures.command;
  if (cmd.panX || cmd.panY) {
    map.panBy([cmd.panX * dt, cmd.panY * dt], { animate: false });
  }
  if (cmd.zoom) {
    const z = clamp(map.getZoom() + cmd.zoom * dt, ZOOM_MIN, ZOOM_MAX);
    if (Math.abs(z - map.getZoom()) > 0.001) map.setZoom(z, { animate: false });
  }
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);

// ---- Keyboard fallback (for dev without the board) --------------------------

document.addEventListener("keydown", (e) => {
  const step = 80;
  switch (e.key) {
    case "ArrowLeft":  map.panBy([-step, 0]); break;
    case "ArrowRight": map.panBy([step, 0]);  break;
    case "ArrowUp":    map.panBy([0, -step]); break;
    case "ArrowDown":  map.panBy([0, step]);  break;
    case "+":
    case "=":          map.setZoom(map.getZoom() + 0.5); break;
    case "-":          map.setZoom(map.getZoom() - 0.5); break;
    case "r":
    case "R":          gestures.resetRezero(); break;
  }
});
