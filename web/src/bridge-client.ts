import type { BoardSample } from "./types";

export interface BridgeClientOptions {
  url?: string;
  initialReconnectMs?: number;
  maxReconnectMs?: number;
}

export class BridgeClient extends EventTarget {
  readonly url: string;
  connected = false;

  private ws: WebSocket | null = null;
  private reconnectMs: number;
  private readonly initialReconnectMs: number;
  private readonly maxReconnectMs: number;
  private reconnectTimer: number | null = null;

  constructor(opts: BridgeClientOptions = {}) {
    super();
    this.url = opts.url ?? "ws://localhost:8765";
    this.initialReconnectMs = opts.initialReconnectMs ?? 500;
    this.maxReconnectMs = opts.maxReconnectMs ?? 5000;
    this.reconnectMs = this.initialReconnectMs;
    this.connect();
  }

  close(): void {
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
    this.connected = false;
  }

  private connect(): void {
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      this.connected = true;
      this.reconnectMs = this.initialReconnectMs;
      this.dispatchEvent(new Event("open"));
    };
    socket.onmessage = (evt) => {
      let sample: BoardSample;
      try {
        sample = JSON.parse(evt.data as string) as BoardSample;
      } catch {
        return;
      }
      this.dispatchEvent(new CustomEvent<BoardSample>("sample", { detail: sample }));
    };
    socket.onclose = () => {
      this.connected = false;
      this.dispatchEvent(new Event("close"));
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      // close handler will follow and trigger reconnect
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectMs);
    this.reconnectMs = Math.min(this.maxReconnectMs, Math.round(this.reconnectMs * 1.5));
  }
}
