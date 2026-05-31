import type { DashboardState, Severity } from '../types';

/* ─────────────────────────────────────────────────────────
   wsClient  —  WebSocket 클라이언트
   역할: gateway_bridge.py(:8765) 연결 / 자동 재연결 / 이벤트 콜백
   W3에서 onState 콜백에 D3 패널 갱신 로직이 추가됨
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

  /** 브라우저 → 브릿지: 시나리오 주입 (PRD §4.4) */
  sendScenario(scenario: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'inject_scenario', scenario }));
    }
  }

  /** 브라우저 → 브릿지: 임계값 조정 (PRD §5.2 Threshold Control) */
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
      console.info('[WS] 연결됨:', WS_URL);
      this.onStatus(true);
    };

    this.ws.onclose = () => {
      console.info('[WS] 연결 끊김. 재연결 예정...');
      this.onStatus(false);
      this._scheduleReconnect();
    };

    this.ws.onerror = () => { /* onclose 가 이어서 처리 */ };

    this.ws.onmessage = (ev) => {
      try {
        const state = JSON.parse(ev.data as string) as DashboardState;
        this.onState(state);
      } catch (e) {
        console.warn('[WS] 파싱 오류:', e);
      }
    };
  }

  private _scheduleReconnect(): void {
    if (!this.closing) setTimeout(() => this._connect(), RECONNECT_MS);
  }
}

/** 전 노드 중 최악 심각도 반환 (PRD §4.2 getWorstSeverity) */
export function getWorstSeverity(nodes: DashboardState['nodes']): Severity {
  const rank: Record<Severity, number> = { normal: 0, warning: 1, critical: 2 };
  return nodes.reduce<Severity>(
    (worst, n) => (rank[n.severity] > rank[worst] ? n.severity : worst),
    'normal',
  );
}
