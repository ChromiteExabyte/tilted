// bridge-client.js — WebSocket client for the balance board bridge.
// Auto-reconnects. Single subscriber per consumer; consumers register an onSample callback.

(function (global) {
  "use strict";

  class BridgeClient extends EventTarget {
    constructor(url = "ws://localhost:8765") {
      super();
      this.url = url;
      this.ws = null;
      this.reconnectMs = 500;
      this.maxReconnectMs = 5000;
      this.connected = false;
      this._connect();
    }

    _connect() {
      try {
        this.ws = new WebSocket(this.url);
      } catch (e) {
        this._scheduleReconnect();
        return;
      }
      this.ws.onopen = () => {
        this.connected = true;
        this.reconnectMs = 500;
        this.dispatchEvent(new Event("open"));
      };
      this.ws.onmessage = (evt) => {
        let sample;
        try {
          sample = JSON.parse(evt.data);
        } catch (e) {
          return;
        }
        this.dispatchEvent(new CustomEvent("sample", { detail: sample }));
      };
      this.ws.onclose = () => {
        this.connected = false;
        this.dispatchEvent(new Event("close"));
        this._scheduleReconnect();
      };
      this.ws.onerror = () => {
        // onclose will follow
      };
    }

    _scheduleReconnect() {
      setTimeout(() => this._connect(), this.reconnectMs);
      this.reconnectMs = Math.min(this.maxReconnectMs, this.reconnectMs * 1.5);
    }
  }

  global.BridgeClient = BridgeClient;
})(window);
