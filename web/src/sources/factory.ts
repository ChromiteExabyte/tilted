import { SimulatorSource } from "./simulator";
import type { SampleSource, SourceId } from "./types";
import { WebHIDSource } from "./webhid";
import { WebSocketSource } from "./websocket";

const STORAGE_KEY = "balanceboard.preferredSource";

export function createSource(id: SourceId): SampleSource {
  switch (id) {
    case "simulator": return new SimulatorSource();
    case "websocket": return new WebSocketSource();
    case "webhid":    return new WebHIDSource();
  }
}

export function loadPreferredSource(): SourceId | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "simulator" || v === "websocket" || v === "webhid") return v;
    return null;
  } catch {
    return null;
  }
}

export function savePreferredSource(id: SourceId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // localStorage disabled — best effort.
  }
}

export function clearPreferredSource(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* */ }
}

export interface SourceAvailability {
  id: SourceId;
  displayName: string;
  blurb: string;
  available: boolean;
  unavailableReason?: string;
}

export function listSources(): SourceAvailability[] {
  return [
    {
      id: "simulator",
      displayName: "Demo (simulator)",
      blurb: "Synthetic samples that cycle through every gesture. No hardware needed — useful for trying out the UI.",
      available: true,
    },
    {
      id: "webhid",
      displayName: "Wii Balance Board (WebHID)",
      blurb: "Talk to a paired Balance Board directly from the browser. Chrome / Edge only.",
      available: WebHIDSource.isSupported(),
      unavailableReason: WebHIDSource.isSupported() ? undefined : "WebHID requires Chrome or Edge.",
    },
    {
      id: "websocket",
      displayName: "Bridge server (WebSocket)",
      blurb: "Connect to balance_bridge.py running on a Linux host (default ws://localhost:8765).",
      available: true,
    },
  ];
}
