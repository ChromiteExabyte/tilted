import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketSource } from "../src/sources/websocket";
import type { BoardSample } from "../src/types";
import { isSampleEvent, isStatusEvent } from "../src/sources/types";

/**
 * Minimal stand-in for the browser WebSocket. Vitest runs in Node, which has
 * no built-in WebSocket, and we don't want a real network in tests anyway.
 * Tests drive the lifecycle by calling open()/recv()/closeRemote() on the
 * instance returned via a constructor-capture handle.
 */
class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  static instances: FakeWebSocket[] = [];
  static throwOnConstruct = false;

  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    if (FakeWebSocket.throwOnConstruct) throw new Error("simulated construct failure");
    this.url = url;
    FakeWebSocket.last = this;
    FakeWebSocket.instances.push(this);
  }

  open(): void { this.onopen?.(); }
  recv(payload: string): void { this.onmessage?.({ data: payload }); }
  fail(): void { this.onerror?.(); }
  closeRemote(): void { this.onclose?.(); }
  close(): void { this.closed = true; }
}

const SAMPLE: BoardSample = {
  ts: 12345.6,
  present: true,
  total_kg: 78,
  TL: 20, TR: 19, BL: 19, BR: 20,
  cop_x: 0.05, cop_y: -0.02,
  left_share: 0.5, right_share: 0.5,
};

beforeEach(() => {
  FakeWebSocket.last = null;
  FakeWebSocket.instances = [];
  FakeWebSocket.throwOnConstruct = false;
  // @ts-expect-error — installing a partial WebSocket impl for the unit under test
  globalThis.WebSocket = FakeWebSocket;
  vi.useFakeTimers();
  // websocket.ts schedules retries via window.setTimeout. In node tests, expose
  // the global timer functions on a window stand-in. Use property accessors
  // (not bound captures) so vi's fake timers — installed AFTER this stub — are
  // dispatched to.
  vi.stubGlobal("window", {
    get setTimeout() { return globalThis.setTimeout; },
    get clearTimeout() { return globalThis.clearTimeout; },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("WebSocketSource", () => {
  it("transitions idle → connecting → connected on open", async () => {
    const src = new WebSocketSource({ url: "ws://test" });
    const statuses: string[] = [];
    src.addEventListener("statuschange", (e) => {
      if (isStatusEvent(e)) statuses.push(e.detail.status);
    });

    await src.start();
    expect(statuses).toEqual(["connecting"]);
    FakeWebSocket.last!.open();
    expect(statuses).toEqual(["connecting", "connected"]);
  });

  it("emits a sample event for each well-formed JSON frame", async () => {
    const src = new WebSocketSource({ url: "ws://test" });
    const samples: BoardSample[] = [];
    src.addEventListener("sample", (e) => {
      if (isSampleEvent(e)) samples.push(e.detail);
    });
    await src.start();
    FakeWebSocket.last!.open();
    FakeWebSocket.last!.recv(JSON.stringify(SAMPLE));
    FakeWebSocket.last!.recv(JSON.stringify({ ...SAMPLE, total_kg: 80 }));
    expect(samples).toHaveLength(2);
    expect(samples[0]!.total_kg).toBe(78);
    expect(samples[1]!.total_kg).toBe(80);
  });

  it("silently drops malformed JSON instead of throwing", async () => {
    const src = new WebSocketSource({ url: "ws://test" });
    const samples: BoardSample[] = [];
    src.addEventListener("sample", (e) => {
      if (isSampleEvent(e)) samples.push(e.detail);
    });
    await src.start();
    FakeWebSocket.last!.open();
    expect(() => FakeWebSocket.last!.recv("{not json")).not.toThrow();
    expect(samples).toHaveLength(0);
  });

  it("auto-reconnects after remote close with exponential backoff", async () => {
    const src = new WebSocketSource({
      url: "ws://test",
      initialReconnectMs: 100,
      maxReconnectMs: 1000,
    });
    await src.start();
    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.last!.open();
    FakeWebSocket.last!.closeRemote();
    // First retry at 100 ms.
    vi.advanceTimersByTime(100);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Second close should schedule the next retry at 150 ms (×1.5 backoff).
    FakeWebSocket.last!.closeRemote();
    vi.advanceTimersByTime(149);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("resets backoff after a successful open", async () => {
    const src = new WebSocketSource({ url: "ws://test", initialReconnectMs: 100 });
    await src.start();

    // Cycle: connect → close (no open) → reconnect should still use 100 ms after a successful open.
    FakeWebSocket.last!.closeRemote();
    vi.advanceTimersByTime(100);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Next attempt should escalate: 150 ms.
    FakeWebSocket.last!.closeRemote();
    vi.advanceTimersByTime(150);
    expect(FakeWebSocket.instances).toHaveLength(3);

    // Successful open resets backoff.
    FakeWebSocket.last!.open();
    FakeWebSocket.last!.closeRemote();
    vi.advanceTimersByTime(100);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it("stop() prevents further reconnects", async () => {
    const src = new WebSocketSource({ url: "ws://test", initialReconnectMs: 100 });
    await src.start();
    FakeWebSocket.last!.open();
    src.stop();
    FakeWebSocket.last!.closeRemote();

    // Even after the backoff window elapses, no new socket should be created.
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("schedules a reconnect when the constructor throws", async () => {
    FakeWebSocket.throwOnConstruct = true;
    const src = new WebSocketSource({ url: "ws://test", initialReconnectMs: 100 });
    await src.start();
    // First attempt threw, so no instance recorded.
    expect(FakeWebSocket.instances).toHaveLength(0);

    // Allow the constructor to succeed on the next try.
    FakeWebSocket.throwOnConstruct = false;
    vi.advanceTimersByTime(100);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("emits disconnected status when the remote closes", async () => {
    const src = new WebSocketSource({ url: "ws://test" });
    const statuses: string[] = [];
    src.addEventListener("statuschange", (e) => {
      if (isStatusEvent(e)) statuses.push(e.detail.status);
    });
    await src.start();
    FakeWebSocket.last!.open();
    FakeWebSocket.last!.closeRemote();
    expect(statuses).toEqual(["connecting", "connected", "disconnected"]);
  });
});
