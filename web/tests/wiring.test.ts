import { describe, expect, it } from "vitest";
import { bindConnButton } from "../src/sources/wiring";
import { BaseSampleSource } from "../src/sources/base";
import type { SourceId, SourceStatus } from "../src/sources/types";

class TestSource extends BaseSampleSource {
  readonly id: SourceId = "simulator";
  readonly displayName = "Test Source";
  async start(): Promise<void> { /* no-op */ }
  stop(): void { /* no-op */ }
  publishStatus(s: SourceStatus, msg?: string): void { this.setStatus(s, msg); }
}

/** Minimal HTMLButtonElement stand-in for node-environment tests. */
function fakeButton(): HTMLButtonElement {
  const classes = new Set<string>();
  const fake = {
    textContent: "init",
    classList: {
      add: (c: string) => { classes.add(c); },
      remove: (c: string) => { classes.delete(c); },
      contains: (c: string) => classes.has(c),
    },
  };
  return fake as unknown as HTMLButtonElement;
}

describe("bindConnButton", () => {
  it("renders the initial source status synchronously", () => {
    const src = new TestSource();
    const btn = fakeButton();
    bindConnButton(src, btn);
    expect(btn.textContent).toBe("○ Test Source");
    expect(btn.classList.contains("ok")).toBe(false);
  });

  it("transitions text + ok class through connecting → connected → disconnected", () => {
    const src = new TestSource();
    const btn = fakeButton();
    bindConnButton(src, btn);

    src.publishStatus("connecting");
    expect(btn.textContent).toBe("○ Test Source");
    expect(btn.classList.contains("ok")).toBe(false);

    src.publishStatus("connected");
    expect(btn.textContent).toBe("● Test Source");
    expect(btn.classList.contains("ok")).toBe(true);

    src.publishStatus("disconnected");
    expect(btn.textContent).toBe("○ reconnecting");
    expect(btn.classList.contains("ok")).toBe(false);
  });

  it("renders an error glyph for the error state", () => {
    const src = new TestSource();
    const btn = fakeButton();
    bindConnButton(src, btn);
    src.publishStatus("error", "boom");
    expect(btn.textContent).toBe("✕ Test Source");
    expect(btn.classList.contains("ok")).toBe(false);
  });

  it("unbind stops further updates", () => {
    const src = new TestSource();
    const btn = fakeButton();
    const unbind = bindConnButton(src, btn);
    unbind();
    src.publishStatus("connected");
    expect(btn.textContent).toBe("○ Test Source");
  });
});
