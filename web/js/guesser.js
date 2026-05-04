// guesser.js — BalanceGuessr: GeoGuessr with satellite imagery instead of street view.
//
// Two-panel game:
//   STUDY mode  — satellite imagery only, no labels. Pan/zoom to identify terrain.
//   GUESS mode  — OSM map. Pan to place a guess pin. Pin gesture commits.
// Tap [G] or do the pin gesture (toes-only press) to switch and commit.

(function () {
  "use strict";

  const STUDY_ZOOM_MIN = 11;
  const STUDY_ZOOM_MAX = 18;
  const STUDY_INITIAL_ZOOM = 14;
  const GUESS_INITIAL_ZOOM = 5;
  const GUESS_CENTER = [49.5, -82.0]; // Northern Ontario middle

  let state = "STUDY";   // STUDY | GUESS | REVEAL
  let target = null;
  let guess = null;
  let round = 0;
  let totalScore = 0;

  // -------------------------------------------------------------------------
  // Maps
  // -------------------------------------------------------------------------
  const studyMap = L.map("study", {
    zoomControl: false,
    zoomSnap: 0,
    zoomDelta: 0.05,
    inertia: false,
    attributionControl: false,
  });
  const sat = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, minZoom: STUDY_ZOOM_MIN }
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

  let guessMarker = null;
  let targetMarker = null;
  let connectorLine = null;

  // -------------------------------------------------------------------------
  // UI refs
  // -------------------------------------------------------------------------
  const ui = {
    mode: document.getElementById("game-mode"),
    round: document.getElementById("round"),
    score: document.getElementById("score"),
    hud: document.getElementById("hud"),
    revealName: document.getElementById("reveal-name"),
    revealHint: document.getElementById("reveal-hint"),
    revealDist: document.getElementById("reveal-dist"),
    revealScore: document.getElementById("reveal-score"),
    revealPanel: document.getElementById("reveal"),
    studyPanel: document.getElementById("study-panel"),
    guessPanel: document.getElementById("guess-panel"),
    conn: document.getElementById("conn"),
  };

  // -------------------------------------------------------------------------
  // Bridge + gestures
  // -------------------------------------------------------------------------
  const bridge = new BridgeClient("ws://localhost:8765");
  const gestures = new GestureInterpreter();

  bridge.addEventListener("open", () => {
    ui.conn.textContent = "● connected";
    ui.conn.classList.add("ok");
  });
  bridge.addEventListener("close", () => {
    ui.conn.textContent = "○ reconnecting";
    ui.conn.classList.remove("ok");
  });

  bridge.addEventListener("sample", (evt) => gestures.onSample(evt.detail));

  gestures.addEventListener("guesspin", () => {
    if (state === "STUDY") {
      switchTo("GUESS");
    } else if (state === "GUESS") {
      commitGuess();
    } else if (state === "REVEAL") {
      nextRound();
    }
  });

  // Apply pan/zoom commands to the active map only
  let lastT = performance.now();
  function tick(now) {
    const dt = (now - lastT) / 1000;
    lastT = now;
    if (gestures.lastSample && state !== "REVEAL") {
      const cmd = gestures._command(gestures.lastSample);
      const m = state === "STUDY" ? studyMap : guessMap;
      if (cmd.panX || cmd.panY) {
        m.panBy([cmd.panX * dt, cmd.panY * dt], { animate: false });
      }
      if (cmd.zoom) {
        const min = state === "STUDY" ? STUDY_ZOOM_MIN : 3;
        const max = state === "STUDY" ? STUDY_ZOOM_MAX : 18;
        const z = Math.max(min, Math.min(max, m.getZoom() + cmd.zoom * dt));
        if (Math.abs(z - m.getZoom()) > 0.001) m.setZoom(z, { animate: false });
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // -------------------------------------------------------------------------
  // Game flow
  // -------------------------------------------------------------------------

  async function loadLocations() {
    const r = await fetch("data/locations.json");
    return await r.json();
  }

  function pickTarget(data) {
    const list = data.locations;
    return list[Math.floor(Math.random() * list.length)];
  }

  function startRound(data) {
    round += 1;
    target = pickTarget(data);
    guess = null;
    ui.round.textContent = `round ${round}`;
    if (guessMarker) { guessMap.removeLayer(guessMarker); guessMarker = null; }
    if (targetMarker) { guessMap.removeLayer(targetMarker); targetMarker = null; }
    if (connectorLine) { guessMap.removeLayer(connectorLine); connectorLine = null; }

    // Drop player into study mode at the target with a small offset, high zoom
    // so they have to navigate around to identify it.
    const jitterDeg = 0.05;
    const lat = target.lat + (Math.random() - 0.5) * jitterDeg;
    const lon = target.lon + (Math.random() - 0.5) * jitterDeg;
    studyMap.setView([lat, lon], STUDY_INITIAL_ZOOM, { animate: false });
    guessMap.setView(GUESS_CENTER, GUESS_INITIAL_ZOOM, { animate: false });
    switchTo("STUDY");
    ui.revealPanel.classList.add("hidden");
  }

  function switchTo(mode) {
    state = mode;
    ui.mode.textContent = mode;
    ui.studyPanel.classList.toggle("active", mode === "STUDY");
    ui.guessPanel.classList.toggle("active", mode === "GUESS");
    if (mode === "GUESS") {
      // Show a pin at the current guessMap center; user will pan to refine.
      const c = guessMap.getCenter();
      guessMarker = L.marker(c, { interactive: false }).addTo(guessMap);
      guessMap.on("move", updateGuessMarker);
    } else {
      guessMap.off("move", updateGuessMarker);
    }
  }

  function updateGuessMarker() {
    if (guessMarker) guessMarker.setLatLng(guessMap.getCenter());
  }

  function commitGuess() {
    guess = guessMap.getCenter();
    const distKm = haversineKm(guess.lat, guess.lng, target.lat, target.lon);
    const score = scoreFor(distKm);
    totalScore += score;
    ui.score.textContent = `${totalScore} pts`;

    targetMarker = L.circleMarker([target.lat, target.lon], {
      radius: 8, color: "#e8c547", weight: 3, fillOpacity: 0.6,
    }).addTo(guessMap);
    connectorLine = L.polyline(
      [[guess.lat, guess.lng], [target.lat, target.lon]],
      { color: "#e8c547", dashArray: "4 6", weight: 2 }
    ).addTo(guessMap);

    const bounds = L.latLngBounds([guess, [target.lat, target.lon]]).pad(0.5);
    guessMap.fitBounds(bounds, { animate: true });

    ui.revealName.textContent = target.name;
    ui.revealHint.textContent = target.hint || "";
    ui.revealDist.textContent = distKm < 1
      ? `${(distKm * 1000).toFixed(0)} m`
      : `${distKm.toFixed(1)} km`;
    ui.revealScore.textContent = `+${score} pts`;
    ui.revealPanel.classList.remove("hidden");
    state = "REVEAL";
    ui.mode.textContent = "REVEAL";
  }

  function nextRound() {
    loadLocations().then(startRound);
  }

  // -------------------------------------------------------------------------
  // Math
  // -------------------------------------------------------------------------
  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function scoreFor(km) {
    // 5000 at 0 km, 0 at >= 1500 km. Exponential falloff feels right.
    const s = 5000 * Math.exp(-km / 250);
    return Math.max(0, Math.round(s));
  }

  // -------------------------------------------------------------------------
  // Keyboard fallback for testing
  // -------------------------------------------------------------------------
  document.addEventListener("keydown", (e) => {
    const m = state === "STUDY" ? studyMap : guessMap;
    const step = 60;
    if (e.key === "ArrowLeft") m.panBy([-step, 0]);
    if (e.key === "ArrowRight") m.panBy([step, 0]);
    if (e.key === "ArrowUp") m.panBy([0, -step]);
    if (e.key === "ArrowDown") m.panBy([0, step]);
    if (e.key === "+" || e.key === "=") m.setZoom(m.getZoom() + 0.5);
    if (e.key === "-") m.setZoom(m.getZoom() - 0.5);
    if (e.key === "g" || e.key === "G") {
      if (state === "STUDY") switchTo("GUESS");
      else if (state === "GUESS") commitGuess();
      else if (state === "REVEAL") nextRound();
    }
  });

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  loadLocations().then(startRound);
})();
