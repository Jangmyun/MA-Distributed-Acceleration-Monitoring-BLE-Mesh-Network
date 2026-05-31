import type { DashboardState, Severity } from '../types';

/* ─────────────────────────────────────────────────────────
   wsClient  —  WebSocket client
   Connects to gateway_bridge.py (:8765), auto-reconnects,
   and exposes event callbacks.
   W3: D3 panel update logic will be added to the onState callback.
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

  /** Browser → bridge: scenario injection (PRD §4.4) */
  sendScenario(scenario: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'inject_scenario', scenario }));
    }
  }

  /** Browser → bridge: threshold adjustment (PRD §5.2 Threshold Control) */
  sendThreshold(params: Record<string, number>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'set_threshold', ...params }));
    }
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

/** Returns the worst severity across all nodes (PRD §4.2 getWorstSeverity) */
export function getWorstSeverity(nodes: DashboardState['nodes']): Severity {
  const rank: Record<Severity, number> = { normal: 0, warning: 1, critical: 2 };
  return nodes.reduce<Severity>(
    (worst, n) => (rank[n.severity] > rank[worst] ? n.severity : worst),
    'normal',
  );
}
