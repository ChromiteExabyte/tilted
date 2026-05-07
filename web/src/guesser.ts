import { L } from "./leaflet-setup";
import { GestureInterpreter } from "./gestures";
import {
  PERFECT_SCORE,
  ROUNDS_PER_GAME,
  formatDistance,
  haversineKm,
  loadBestScore,
  saveBestScore,
  scoreFor,
  shuffle,
} from "./scoring";
import {
  pickAndStartSource,
  showPicker,
  isSampleEvent,
  bindConnButton,
  clearPreferredSource,
  type SampleSource,
} from "./sources";
import type { GestureStatus, ModeChangeDetail, StatusChangeDetail } from "./types";
import locationsData from "./locations.json";
import "./style.css";

interface Location {
  name: string;
  lat: number;
  lon: number;
  category: string;
  hint: string;
}

interface RoundResult {
  target: Location;
  distKm: number;
  score: number;
}

const LOCATIONS = locationsData.locations as Location[];

const STUDY_ZOOM_MIN = 11;
const STUDY_ZOOM_MAX = 18;
const STUDY_INITIAL_ZOOM = 14;
const GUESS_INITIAL_ZOOM = 5;
const GUESS_CENTER: L.LatLngTuple = [49.5, -82.0]; // roughly the geometric centre of Ontario
const TARGET_JITTER_DEG = 0.05;
/** Cap per-frame dt at 100 ms — see map.ts for rationale (tab-resume jumps). */
const MAX_DT_S = 0.1;
/**
 * CSS scale applied to the study map so that rotated corners don't show
 * blank tile areas. √2 ≈ 1.414 is the worst case; 1.5 gives a small margin.
 */
const STUDY_SCALE = 1.5;

type GameState = "STUDY" | "GUESS" | "REVEAL" | "SUMMARY";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

const ui = {
  mode: $<HTMLSpanElement>("game-mode"),
  round: $<HTMLSpanElement>("round"),
  score: $<HTMLSpanElement>("score"),
  best: $<HTMLSpanElement>("best"),
  phase: $<HTMLSpanElement>("phase"),
  revealName: $<HTMLDivElement>("reveal-name"),
  revealHint: $<HTMLSpanElement>("reveal-hint"),
  revealDist: $<HTMLSpanElement>("reveal-dist"),
  revealScore: $<HTMLSpanElement>("reveal-score"),
  revealPanel: $<HTMLDivElement>("reveal"),
  studyPanel: $<HTMLDivElement>("study-panel"),
  guessPanel: $<HTMLDivElement>("guess-panel"),
  summaryPanel: $<HTMLDivElement>("summary"),
  summaryTotal: $<HTMLSpanElement>("summary-total"),
  summaryBest: $<HTMLSpanElement>("summary-best"),
  summaryNewBest: $<HTMLSpanElement>("summary-new-best"),
  summaryRows: $<HTMLDivElement>("summary-rounds"),
  conn: $<HTMLButtonElement>("conn"),
  pickerRoot: $<HTMLDivElement>("picker-root"),
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
let round = 0;
let totalScore = 0;
let bestScore = loadBestScore();
let pool: Location[] = [];
let target: Location | null = null;
let results: RoundResult[] = [];
/** Current clockwise rotation (degrees) applied to the study map. */
let studyRotation = 0;

ui.best.textContent = `${bestScore} pts`;

// ---- Source + gestures ------------------------------------------------------

const gestures = new GestureInterpreter();
let currentSource: SampleSource | null = null;
let unbindConn: (() => void) | null = null;

function attachSource(source: SampleSource): void {
  currentSource = source;
  unbindConn?.();
  unbindConn = bindConnButton(source, ui.conn);

  source.addEventListener("sample", (evt) => {
    if (!isSampleEvent(evt)) return;
    gestures.onSample(evt.detail);
  });
}

ui.conn.addEventListener("click", async () => {
  if (currentSource) currentSource.stop();
  clearPreferredSource();
  gestures.resetRezero();
  const next = await showPicker(ui.pickerRoot);
  attachSource(next);
});

void pickAndStartSource(ui.pickerRoot).then(attachSource);

// Step off the board → advance from STUDY or GUESS phases.
gestures.addEventListener("footoff", () => {
  if (state === "STUDY" || state === "GUESS") advance();
});
// Step back on the board → acknowledge result and continue.
gestures.addEventListener("footon", () => {
  if (state === "REVEAL" || state === "SUMMARY") advance();
});
gestures.addEventListener("modechange", (evt) => {
  if (state === "REVEAL" || state === "SUMMARY") return;
  if (gestures.status === "REZEROING") return;
  ui.phase.textContent = (evt as CustomEvent<ModeChangeDetail>).detail.to.toLowerCase();
});
gestures.addEventListener("statuschange", (evt) => {
  ui.phase.textContent = PHASE_LABELS[(evt as CustomEvent<StatusChangeDetail>).detail.to];
});
ui.phase.textContent = PHASE_LABELS[gestures.status];

// ---- Frame-rate command application -----------------------------------------

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

let lastT = performance.now();
const tick = (now: number): void => {
  const dt = Math.min(MAX_DT_S, (now - lastT) / 1000);
  lastT = now;
  if ((state === "STUDY" || state === "GUESS") && gestures.status === "READY") {
    const cmd = gestures.tick(dt);
    const m = state === "STUDY" ? studyMap : guessMap;
    if (cmd.panX || cmd.panY) {
      if (state === "STUDY" && studyRotation !== 0) {
        // Rotate body-tilt vectors so "lean forward" = visual up, regardless of
        // how much the study map is CSS-rotated this round.
        const θ = (studyRotation * Math.PI) / 180;
        const c = Math.cos(θ);
        const s = Math.sin(θ);
        const lx = cmd.panX * c - cmd.panY * s;
        const ly = cmd.panX * s + cmd.panY * c;
        m.panBy([lx * dt, ly * dt], { animate: false });
      } else {
        m.panBy([cmd.panX * dt, cmd.panY * dt], { animate: false });
      }
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

function newGame(): void {
  pool = shuffle(LOCATIONS);
  results = [];
  totalScore = 0;
  round = 0;
  ui.score.textContent = "0 pts";
  ui.summaryPanel.classList.add("hidden");
  startRound();
}

function startRound(): void {
  if (pool.length === 0) {
    // Defensive: shouldn't happen with N <= LOCATIONS.length, but reshuffle if so.
    pool = shuffle(LOCATIONS);
  }
  round = results.length + 1;
  target = pool.pop()!;
  ui.round.textContent = `round ${round} of ${ROUNDS_PER_GAME}`;
  clearRoundLayers();

  // Random bearing each round — satellite is never north-up.
  studyRotation = Math.random() * 360;
  studyMap.getContainer().style.transform =
    `rotate(${studyRotation}deg) scale(${STUDY_SCALE})`;

  const lat = target.lat + (Math.random() - 0.5) * TARGET_JITTER_DEG;
  const lon = target.lon + (Math.random() - 0.5) * TARGET_JITTER_DEG;
  studyMap.setView([lat, lon], STUDY_INITIAL_ZOOM, { animate: false });
  guessMap.setView(GUESS_CENTER, GUESS_INITIAL_ZOOM, { animate: false });
  switchTo("STUDY");
  ui.revealPanel.classList.add("hidden");
}

function clearRoundLayers(): void {
  if (guessMarker)   { guessMap.removeLayer(guessMarker);   guessMarker = null; }
  if (targetMarker)  { guessMap.removeLayer(targetMarker);  targetMarker = null; }
  if (connectorLine) { guessMap.removeLayer(connectorLine); connectorLine = null; }
}

function switchTo(next: GameState): void {
  state = next;
  ui.mode.textContent = next;
  ui.studyPanel.classList.toggle("active", next === "STUDY");
  ui.guessPanel.classList.toggle("active", next === "GUESS");
  if (next === "GUESS") {
    // Replace any prior marker (Escape→STUDY→GUESS would otherwise stack them).
    if (guessMarker) guessMap.removeLayer(guessMarker);
    guessMarker = L.marker(guessMap.getCenter(), { interactive: false }).addTo(guessMap);
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

  results.push({ target, distKm, score });
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
  ui.revealDist.textContent = formatDistance(distKm);
  ui.revealScore.textContent = `+${score} pts`;
  ui.revealPanel.classList.remove("hidden");
  state = "REVEAL";
  ui.mode.textContent = "REVEAL";
}

function showSummary(): void {
  state = "SUMMARY";
  ui.mode.textContent = "SUMMARY";
  ui.revealPanel.classList.add("hidden");

  const isNewBest = totalScore > bestScore;
  if (isNewBest) {
    bestScore = totalScore;
    saveBestScore(bestScore);
  }
  ui.best.textContent = `${bestScore} pts`;
  ui.summaryTotal.textContent = `${totalScore} pts`;
  ui.summaryBest.textContent = `${bestScore} pts`;
  ui.summaryNewBest.classList.toggle("hidden", !isNewBest);

  ui.summaryRows.innerHTML = "";
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const row = document.createElement("div");
    row.className = "summary-row";
    row.innerHTML = `
      <span class="r-num">${i + 1}</span>
      <span class="r-name">${escapeHtml(r.target.name)}</span>
      <span class="r-dist">${formatDistance(r.distKm)}</span>
      <span class="r-score">${r.score === PERFECT_SCORE ? "★ " : ""}${r.score}</span>
    `;
    ui.summaryRows.appendChild(row);
  }
  ui.summaryPanel.classList.remove("hidden");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function advance(): void {
  switch (state) {
    case "STUDY":
      switchTo("GUESS");
      break;
    case "GUESS":
      commitGuess();
      break;
    case "REVEAL":
      if (results.length >= ROUNDS_PER_GAME) showSummary();
      else startRound();
      break;
    case "SUMMARY":
      newGame();
      break;
  }
}

// ---- Keyboard fallback ------------------------------------------------------

document.addEventListener("keydown", (e) => {
  if (e.key === "g" || e.key === "G") { advance(); return; }
  if (e.key === "r" || e.key === "R") { gestures.resetRezero(); return; }
  // Escape during GUESS rewinds to STUDY (re-look at the imagery before committing).
  if (e.key === "Escape" && state === "GUESS") { switchTo("STUDY"); return; }
  if (state === "REVEAL" || state === "SUMMARY") return;
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

newGame();
