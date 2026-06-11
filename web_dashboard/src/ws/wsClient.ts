import type { DashboardState } from '../types';

/* ─────────────────────────────────────────────────────────
   wsClient  —  WebSocket client
   Connects to gateway_bridge.py (:8765), auto-reconnects,
   and exposes event callbacks.
───────────────────────────────────────────────────────── */

const WS_URL        = 'ws://localhost:8765';
const RECONNECT_MS  = 5_000;

export type WsStatusCallback = (connected: boolean) => void;
export type WsStateCallback  = (state: DashboardState) => void;

export class WsClient {
  private ws:      WebSocket | null = null;
  private closing  = false;

  constructor(
    private readonly onState:  WsStateCallback,
    private readonly onStatus: WsStatusCallback,
  ) {
    this._connect();
  }

  dispose(): void {
    this.closing = true;
    this.ws?.close();
  }

  private _connect(): void {
    if (this.closing) return;
    try {
      this.ws = new WebSocket(WS_URL);
    } catch {
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.info('[WS] Connected:', WS_URL);
      this.onStatus(true);
    };

    this.ws.onclose = () => {
      console.info('[WS] Disconnected. Reconnecting...');
      this.onStatus(false);
      this._scheduleReconnect();
    };

    this.ws.onerror = () => { /* handled by onclose */ };

    this.ws.onmessage = (ev) => {
      try {
        const state = JSON.parse(ev.data as string) as DashboardState;
        this.onState(state);
      } catch (e) {
        console.warn('[WS] Parse error:', e);
      }
    };
  }

  private _scheduleReconnect(): void {
    if (!this.closing) setTimeout(() => this._connect(), RECONNECT_MS);
  }
}
