import {
  type SourceAvailability,
  createSource,
  listSources,
  loadPreferredSource,
  savePreferredSource,
} from "./factory";
import type { SampleSource, SourceId } from "./types";

/**
 * Mounts the source-picker UI and resolves with a started source.
 *
 * On first visit the modal is shown. If the user has a saved preference, the
 * modal is skipped and the saved source is started immediately. The user can
 * always re-open the picker by clicking the source pill in the topbar.
 */
export async function pickAndStartSource(rootContainer: HTMLElement): Promise<SampleSource> {
  const saved = loadPreferredSource();
  if (saved) {
    const source = createSource(saved);
    try {
      await source.start();
      return source;
    } catch {
      // Saved choice failed — fall back to the picker so the user can choose again.
    }
  }
  return showPicker(rootContainer);
}

export function showPicker(rootContainer: HTMLElement): Promise<SampleSource> {
  return new Promise((resolve) => {
    const modal = renderModal(rootContainer);
    const cleanup = () => modal.element.remove();

    modal.onChoice(async (id, savePreference) => {
      const source = createSource(id);
      modal.setStatus(`starting ${source.displayName}…`);
      try {
        await source.start();
        if (savePreference) savePreferredSource(id);
        cleanup();
        resolve(source);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        modal.setStatus(`failed: ${msg}`, "error");
      }
    });
  });
}

interface ModalHandle {
  element: HTMLElement;
  onChoice(handler: (id: SourceId, savePreference: boolean) => void): void;
  setStatus(message: string, kind?: "info" | "error"): void;
}

function renderModal(container: HTMLElement): ModalHandle {
  const overlay = document.createElement("div");
  overlay.className = "source-picker";
  overlay.innerHTML = `
    <div class="source-picker__panel">
      <div class="source-picker__title">Connect to a balance board</div>
      <div class="source-picker__sub">Pick how this page receives sensor data.</div>
      <div class="source-picker__list" role="list"></div>
      <label class="source-picker__remember">
        <input type="checkbox" checked> Remember choice for next visit
      </label>
      <div class="source-picker__status" data-kind="info"></div>
    </div>
  `;
  container.appendChild(overlay);

  const list = overlay.querySelector<HTMLDivElement>(".source-picker__list")!;
  const remember = overlay.querySelector<HTMLInputElement>(".source-picker__remember input")!;
  const statusEl = overlay.querySelector<HTMLDivElement>(".source-picker__status")!;
  const sources = listSources();
  const choiceHandlers: ((id: SourceId, save: boolean) => void)[] = [];

  for (const s of sources) {
    list.appendChild(renderSourceButton(s, (id) => {
      for (const h of choiceHandlers) h(id, remember.checked);
    }));
  }

  return {
    element: overlay,
    onChoice(handler) { choiceHandlers.push(handler); },
    setStatus(message, kind = "info") {
      statusEl.textContent = message;
      statusEl.dataset.kind = kind;
    },
  };
}

function renderSourceButton(s: SourceAvailability, onClick: (id: SourceId) => void): HTMLElement {
  const btn = document.createElement("button");
  btn.className = "source-picker__option";
  btn.disabled = !s.available;
  btn.dataset.source = s.id;
  btn.innerHTML = `
    <div class="source-picker__option-name">${s.displayName}</div>
    <div class="source-picker__option-blurb">${s.blurb}</div>
    ${s.unavailableReason ? `<div class="source-picker__option-warn">${s.unavailableReason}</div>` : ""}
    <div class="source-picker__option-arrow">→</div>
  `;
  btn.addEventListener("click", () => onClick(s.id));
  return btn;
}
