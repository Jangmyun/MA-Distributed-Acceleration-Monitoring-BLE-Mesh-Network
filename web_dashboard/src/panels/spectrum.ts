import type { DashboardState } from '../types';

/* ─────────────────────────────────────────────────────────
   spectrum.ts  —  D3.js FFT 스펙트럼 바 차트
   W3 구현 예정: 3노드 top8_bins + 기준선 오버레이
   현재: placeholder 렌더링
───────────────────────────────────────────────────────── */

export function initSpectrum(container: HTMLElement): void {
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                height:100%;color:#8b949e;font-family:monospace;gap:8px;">
      <div style="font-size:32px;">📊</div>
      <div style="font-size:12px;">FFT 스펙트럼</div>
      <div style="font-size:11px;">3노드 Bar Chart + 기준선 오버레이</div>
      <div style="font-size:10px;padding:2px 8px;border-radius:4px;background:#21262d;color:#58a6ff;">
        W3 구현 예정
      </div>
    </div>`;
}

// W3에서 이 함수를 구현 — wsClient.onState 콜백에서 호출됨
export function updateSpectrum(_state: DashboardState): void {
  // TODO W3: D3.js bar chart로 top8_bins 갱신 + 기준선 오버레이
}
