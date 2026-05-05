import { L } from "./leaflet-setup";
import { GestureInterpreter } from "./gestures";
import {
  pickAndStartSource,
  showPicker,
  isSampleEvent,
  bindConnButton,
  clearPreferredSource,
  type SampleSource,
} from "./sources";
import type { GestureStatus, ModeChangeDetail, StatusChangeDetail } from "./types";
import "./style.css";

const DEFAULT_CENTER: L.LatLngTuple = [49.0639, -81.0167]; // Cochrane, ON
const DEFAULT_ZOOM = 6;
const ZOOM_MIN = 2;
const ZOOM_MAX = 19;
/** Cap per-frame dt at 100 ms so a backgrounded tab doesn't punt the map across the world on resume. */
const MAX_DT_S = 0.1;

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
const connEl = $<HTMLButtonElement>("conn");
const pickerRoot = $("picker-root");

const PHASE_LABELS: Record<GestureStatus, string> = {
  DISCONNECTED: "—",
  REZEROING: "calibrating…",
  READY: "ready",
};

const setPhase = (status: GestureStatus): void => {
  phaseEl.textContent = PHASE_LABELS[status];
  statusEl.dataset.status = status;
};

// ---- Gestures + dynamic source ---------------------------------------------

const gestures = new GestureInterpreter();
let currentSource: SampleSource | null = null;
let unbindConn: (() => void) | null = null;

function attachSource(source: SampleSource): void {
  currentSource = source;
  unbindConn?.();
  unbindConn = bindConnButton(source, connEl);

  source.addEventListener("sample", (evt) => {
    if (!isSampleEvent(evt)) return;
    const sample = evt.detail;
    gestures.onSample(sample);

    weightEl.textContent = sample.present ? `${sample.total_kg.toFixed(1)} kg` : "—";
    const offset = gestures.rezeroOffset;
    const cx = sample.cop_x - offset.x;
    const cy = sample.cop_y - offset.y;
    copDot.style.left = `${((cx + 1) / 2) * 100}%`;
    copDot.style.top = `${((1 - cy) / 2) * 100}%`;
    copDot.classList.toggle("active", sample.present);
  });
}

connEl.addEventListener("click", async () => {
  if (currentSource) currentSource.stop();
  clearPreferredSource();
  gestures.resetRezero();
  const next = await showPicker(pickerRoot);
  attachSource(next);
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

void pickAndStartSource(pickerRoot).then(attachSource);

// ---- Frame-rate command application -----------------------------------------

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

let lastT = performance.now();
const tick = (now: number): void => {
  const dt = Math.min(MAX_DT_S, (now - lastT) / 1000);
  lastT = now;
  if (gestures.status !== "READY") {
    requestAnimationFrame(tick);
    return;
  }
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

// ---- Keyboard fallback ------------------------------------------------------

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
