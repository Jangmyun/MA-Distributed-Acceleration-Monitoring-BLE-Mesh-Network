import type { DashboardState } from '../types';

/* ─────────────────────────────────────────────────────────
   topology.ts  —  D3.js Force-directed 토폴로지 그래프
   W2 구현 예정: BLE Mesh 노드·링크 시각화
   현재: placeholder 렌더링
───────────────────────────────────────────────────────── */

export function initTopology(container: HTMLElement): void {
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                height:100%;color:#8b949e;font-family:monospace;gap:8px;">
      <div style="font-size:32px;">🔗</div>
      <div style="font-size:12px;">BLE Mesh 토폴로지</div>
      <div style="font-size:11px;">Force-directed Graph</div>
      <div style="font-size:10px;padding:2px 8px;border-radius:4px;background:#21262d;color:#58a6ff;">
        W2 구현 예정
      </div>
    </div>`;
}

// W2에서 이 함수를 구현 — wsClient.onState 콜백에서 호출됨
export function updateTopology(_state: DashboardState): void {
  // TODO W2: D3.js force simulation으로 노드/링크 갱신
}
