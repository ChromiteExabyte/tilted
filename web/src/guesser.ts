import { L } from "./leaflet-setup";
import { BridgeClient } from "./bridge-client";
import { GestureInterpreter } from "./gestures";
import type { BoardSample, GestureStatus, ModeChangeDetail, StatusChangeDetail } from "./types";
import locationsData from "./locations.json";
import "./style.css";

interface Location {
  name: string;
  lat: number;
  lon: number;
  category: string;
  hint: string;
}

const LOCATIONS = locationsData.locations as Location[];

const STUDY_ZOOM_MIN = 11;
const STUDY_ZOOM_MAX = 18;
const STUDY_INITIAL_ZOOM = 14;
const GUESS_INITIAL_ZOOM = 5;
const GUESS_CENTER: L.LatLngTuple = [49.5, -82.0];

type GameState = "STUDY" | "GUESS" | "REVEAL";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

const ui = {
  mode: $<HTMLSpanElement>("game-mode"),
  round: $<HTMLSpanElement>("round"),
  score: $<HTMLSpanElement>("score"),
  phase: $<HTMLSpanElement>("phase"),
  revealName: $<HTMLDivElement>("reveal-name"),
  revealHint: $<HTMLSpanElement>("reveal-hint"),
  revealDist: $<HTMLSpanElement>("reveal-dist"),
  revealScore: $<HTMLSpanElement>("reveal-score"),
  revealPanel: $<HTMLDivElement>("reveal"),
  studyPanel: $<HTMLDivElement>("study-panel"),
  guessPanel: $<HTMLDivElement>("guess-panel"),
  conn: $<HTMLDivElement>("conn"),
};

const PHASE_LABELS: Record<GestureStatus, string> = {
  DISCONNECTED: "—",
  REZEROING: "calibrating…",
  READY: "ready",
};

// ---- Maps -------------------------------------------------------------------

const studyMap = L.map("study", {
  zoomControl: false,
  zoomSnap: 0,
  zoomDelta: 0.05,
  inertia: false,
  attributionControl: false,
});
L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  { maxZoom: 19, minZoom: STUDY_ZOOM_MIN },
).addTo(studyMap);

const guessMap = L.map("guess", {
  center: GUESS_CENTER,
  zoom: GUESS_INITIAL_ZOOM,
  zoomControl: false,
  zoomSnap: 0,
  zoomDelta: 0.05,
  inertia: false,
  attributionControl: false,
});
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: "© OpenStreetMap",
}).addTo(guessMap);

let guessMarker: L.Marker | null = null;
let targetMarker: L.CircleMarker | null = null;
let connectorLine: L.Polyline | null = null;

// ---- Game state -------------------------------------------------------------

let state: GameState = "STUDY";
let target: Location | null = null;
let round = 0;
let totalScore = 0;

// ---- Bridge + gestures ------------------------------------------------------

const bridge = new BridgeClient();
const gestures = new GestureInterpreter();

bridge.addEventListener("open", () => {
  ui.conn.textContent = "● connected";
  ui.conn.classList.add("ok");
});
bridge.addEventListener("close", () => {
  ui.conn.textContent = "○ reconnecting";
  ui.conn.classList.remove("ok");
});

bridge.addEventListener("sample", (evt) => {
  gestures.onSample((evt as CustomEvent<BoardSample>).detail);
});

gestures.addEventListener("guesspin", () => advance());
gestures.addEventListener("modechange", (evt) => {
  // Mirror the mode into the phase pill while in active play, but don't
  // overwrite REVEAL or the calibrating message.
  if (state === "REVEAL") return;
  const detail = (evt as CustomEvent<ModeChangeDetail>).detail;
  if (gestures.status === "REZEROING") return;
  ui.phase.textContent = detail.to.toLowerCase();
});
gestures.addEventListener("statuschange", (evt) => {
  ui.phase.textContent = PHASE_LABELS[(evt as CustomEvent<StatusChangeDetail>).detail.to];
});
ui.phase.textContent = PHASE_LABELS[gestures.status];

// ---- Frame-rate command application -----------------------------------------

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

let lastT = performance.now();
const tick = (now: number): void => {
  const dt = (now - lastT) / 1000;
  lastT = now;
  if (state !== "REVEAL") {
    const cmd = gestures.command;
    const m = state === "STUDY" ? studyMap : guessMap;
    if (cmd.panX || cmd.panY) {
      m.panBy([cmd.panX * dt, cmd.panY * dt], { animate: false });
    }
    if (cmd.zoom) {
      const min = state === "STUDY" ? STUDY_ZOOM_MIN : 3;
      const max = state === "STUDY" ? STUDY_ZOOM_MAX : 18;
      const z = clamp(m.getZoom() + cmd.zoom * dt, min, max);
      if (Math.abs(z - m.getZoom()) > 0.001) m.setZoom(z, { animate: false });
    }
  }
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);

// ---- Game flow --------------------------------------------------------------

function pickTarget(): Location {
  const idx = Math.floor(Math.random() * LOCATIONS.length);
  return LOCATIONS[idx]!;
}

function startRound(): void {
  round += 1;
  target = pickTarget();
  ui.round.textContent = `round ${round}`;
  if (guessMarker)    { guessMap.removeLayer(guessMarker);    guessMarker = null; }
  if (targetMarker)   { guessMap.removeLayer(targetMarker);   targetMarker = null; }
  if (connectorLine)  { guessMap.removeLayer(connectorLine);  connectorLine = null; }

  // Drop into study mode at the target with a small offset, high zoom.
  const jitterDeg = 0.05;
  const lat = target.lat + (Math.random() - 0.5) * jitterDeg;
  const lon = target.lon + (Math.random() - 0.5) * jitterDeg;
  studyMap.setView([lat, lon], STUDY_INITIAL_ZOOM, { animate: false });
  guessMap.setView(GUESS_CENTER, GUESS_INITIAL_ZOOM, { animate: false });
  switchTo("STUDY");
  ui.revealPanel.classList.add("hidden");
}

function switchTo(next: GameState): void {
  state = next;
  ui.mode.textContent = next;
  ui.studyPanel.classList.toggle("active", next === "STUDY");
  ui.guessPanel.classList.toggle("active", next === "GUESS");
  if (next === "GUESS") {
    const c = guessMap.getCenter();
    guessMarker = L.marker(c, { interactive: false }).addTo(guessMap);
    guessMap.on("move", updateGuessMarker);
  } else {
    guessMap.off("move", updateGuessMarker);
  }
}

function updateGuessMarker(): void {
  if (guessMarker) guessMarker.setLatLng(guessMap.getCenter());
}

function commitGuess(): void {
  if (!target) return;
  const guess = guessMap.getCenter();
  const distKm = haversineKm(guess.lat, guess.lng, target.lat, target.lon);
  const score = scoreFor(distKm);
  totalScore += score;
  ui.score.textContent = `${totalScore} pts`;

  targetMarker = L.circleMarker([target.lat, target.lon], {
    radius: 8,
    color: "#e8c547",
    weight: 3,
    fillOpacity: 0.6,
  }).addTo(guessMap);
  connectorLine = L.polyline(
    [
      [guess.lat, guess.lng],
      [target.lat, target.lon],
    ],
    { color: "#e8c547", dashArray: "4 6", weight: 2 },
  ).addTo(guessMap);

  const bounds = L.latLngBounds([guess, [target.lat, target.lon]]).pad(0.5);
  guessMap.fitBounds(bounds, { animate: true });

  ui.revealName.textContent = target.name;
  ui.revealHint.textContent = target.hint ?? "";
  ui.revealDist.textContent = distKm < 1
    ? `${(distKm * 1000).toFixed(0)} m`
    : `${distKm.toFixed(1)} km`;
  ui.revealScore.textContent = `+${score} pts`;
  ui.revealPanel.classList.remove("hidden");
  state = "REVEAL";
  ui.mode.textContent = "REVEAL";
}

function advance(): void {
  if (state === "STUDY") {
    switchTo("GUESS");
  } else if (state === "GUESS") {
    commitGuess();
  } else {
    startRound();
  }
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function scoreFor(km: number): number {
  // 5000 at 0 km, exponential falloff with 250 km characteristic distance.
  return Math.max(0, Math.round(5000 * Math.exp(-km / 250)));
}

// ---- Keyboard fallback ------------------------------------------------------

document.addEventListener("keydown", (e) => {
  if (e.key === "g" || e.key === "G") {
    advance();
    return;
  }
  if (e.key === "r" || e.key === "R") {
    gestures.resetRezero();
    return;
  }
  if (state === "REVEAL") return;
  const m = state === "STUDY" ? studyMap : guessMap;
  const step = 60;
  switch (e.key) {
    case "ArrowLeft":  m.panBy([-step, 0]); break;
    case "ArrowRight": m.panBy([step, 0]);  break;
    case "ArrowUp":    m.panBy([0, -step]); break;
    case "ArrowDown":  m.panBy([0, step]);  break;
    case "+":
    case "=":          m.setZoom(m.getZoom() + 0.5); break;
    case "-":          m.setZoom(m.getZoom() - 0.5); break;
  }
});

// ---- Boot -------------------------------------------------------------------

startRound();
