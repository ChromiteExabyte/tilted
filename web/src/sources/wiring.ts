import type { SampleSource, SourceStatus } from "./types";
import { isStatusEvent } from "./types";

/**
 * Bind a connection-pill button to a source's status:
 *   connecting   → "○ {name}"        (no .ok)
 *   connected    → "● {name}"        (.ok)
 *   disconnected → "○ reconnecting"  (no .ok)
 *   error        → "✕ {name}"        (no .ok)
 *
 * Returns an unbind function. Both atlas and guesser used to reimplement this;
 * extracting it here keeps the topbar in lockstep across pages.
 */
export function bindConnButton(source: SampleSource, btn: HTMLButtonElement): () => void {
  const update = (status: SourceStatus): void => {
    switch (status) {
      case "connected":
        btn.textContent = `● ${source.displayName}`;
        btn.classList.add("ok");
        break;
      case "connecting":
      case "idle":
        btn.textContent = `○ ${source.displayName}`;
        btn.classList.remove("ok");
        break;
      case "disconnected":
        btn.textContent = "○ reconnecting";
        btn.classList.remove("ok");
        break;
      case "error":
        btn.textContent = `✕ ${source.displayName}`;
        btn.classList.remove("ok");
        break;
    }
  };
  update(source.status);
  const handler = (evt: Event): void => {
    if (isStatusEvent(evt)) update(evt.detail.status);
  };
  source.addEventListener("statuschange", handler);
  return () => source.removeEventListener("statuschange", handler);
}
