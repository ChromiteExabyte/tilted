import type { BoardSample } from "../types";
import { BaseSampleSource } from "./base";
import type { SourceId } from "./types";

export interface WebSocketSourceOptions {
  url?: string;
  initialReconnectMs?: number;
  maxReconnectMs?: number;
}

/**
 * Connects to the Python `balance_bridge.py` WebSocket. Auto-reconnects on
 * close with exponential backoff. This is the original "bridge" path — Linux
 * host with the board paired via bluez, JSON frames at ~30 Hz.
 */
export class WebSocketSource extends BaseSampleSource {
  readonly id: SourceId = "websocket";
  readonly displayName = "Bridge server";
  readonly url: string;

  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectMs: number;
  private readonly initialReconnectMs: number;
  private readonly maxReconnectMs: number;
  private stopped = false;

  constructor(opts: WebSocketSourceOptions = {}) {
    super();
    this.url = opts.url ?? "ws://localhost:8765";
    this.initialReconnectMs = opts.initialReconnectMs ?? 500;
    this.maxReconnectMs = opts.maxReconnectMs ?? 5000;
    this.reconnectMs = this.initialReconnectMs;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
    this.setStatus("disconnected");
  }

  private connect(): void {
    if (this.stopped) return;
    this.setStatus("connecting", `connecting to ${this.url}`);

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      this.reconnectMs = this.initialReconnectMs;
      this.setStatus("connected");
    };
    socket.onmessage = (evt) => {
      let sample: BoardSample;
      try {
        sample = JSON.parse(evt.data as string) as BoardSample;
      } catch {
        return;
      }
      this.emitSample(sample);
    };
    socket.onclose = () => {
      if (!this.stopped) this.setStatus("disconnected");
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      // close handler will follow and trigger reconnect
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectMs);
    this.reconnectMs = Math.min(this.maxReconnectMs, Math.round(this.reconnectMs * 1.5));
  }
}
