// map.js — main map mode. Wires the gesture interpreter to a Leaflet map.

(function () {
  "use strict";

  // Default view: Cochrane, ON. (Customize freely.)
  const DEFAULT_CENTER = [49.0639, -81.0167];
  const DEFAULT_ZOOM = 6;

  const map = L.map("map", {
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    zoomControl: false,
    zoomSnap: 0,
    zoomDelta: 0.05,
    wheelDebounceTime: 40,
    inertia: false,
  });

  // Layer pickers — Esri World Imagery for satellite, OSM for reference.
  const osm = L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      maxZoom: 19,
      attribution: "© OpenStreetMap",
    }
  );
  const sat = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 19,
      attribution: "Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, GIS User Community",
    }
  );
  sat.addTo(map);

  L.control.layers(
    { Satellite: sat, OpenStreetMap: osm },
    null,
    { position: "topright" }
  ).addTo(map);

  // Status overlay refs
  const statusEl = document.getElementById("status");
  const modeEl = document.getElementById("mode");
  const weightEl = document.getElementById("weight");
  const copDot = document.getElementById("cop-dot");
  const connEl = document.getElementById("conn");

  // Bridge + gesture interpreter
  const bridge = new BridgeClient("ws://localhost:8765");
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
    const sample = evt.detail;
    gestures.onSample(sample);

    weightEl.textContent = sample.present
      ? `${sample.total_kg.toFixed(1)} kg`
      : "—";

    // COP indicator: -1..+1 maps to 0..100 % within the pad
    const x = ((sample.cop_x + 1) / 2) * 100;
    const y = ((1 - sample.cop_y) / 2) * 100; // forward = up
    copDot.style.left = `${x}%`;
    copDot.style.top = `${y}%`;
    copDot.classList.toggle("active", sample.present);
  });

  gestures.addEventListener("modechange", (evt) => {
    modeEl.textContent = evt.detail.to;
    statusEl.dataset.mode = evt.detail.to;
  });

  // -------------------------------------------------------------------------
  // Apply commands to the map at frame rate
  // -------------------------------------------------------------------------
  let lastT = performance.now();
  function tick(now) {
    const dt = (now - lastT) / 1000;
    lastT = now;

    if (gestures.lastSample) {
      const cmd = gestures._command(gestures.lastSample);
      if (cmd.panX || cmd.panY) {
        map.panBy([cmd.panX * dt, cmd.panY * dt], { animate: false });
      }
      if (cmd.zoom) {
        const z = map.getZoom() + cmd.zoom * dt;
        const clamped = Math.max(2, Math.min(19, z));
        if (Math.abs(clamped - map.getZoom()) > 0.001) {
          map.setZoom(clamped, { animate: false });
        }
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // Keyboard fallback for testing without the board
  document.addEventListener("keydown", (e) => {
    const step = 80;
    if (e.key === "ArrowLeft") map.panBy([-step, 0]);
    if (e.key === "ArrowRight") map.panBy([step, 0]);
    if (e.key === "ArrowUp") map.panBy([0, -step]);
    if (e.key === "ArrowDown") map.panBy([0, step]);
    if (e.key === "+" || e.key === "=") map.setZoom(map.getZoom() + 0.5);
    if (e.key === "-") map.setZoom(map.getZoom() - 0.5);
  });
})();
