import type { Severity } from '../types';

/* ─────────────────────────────────────────────────────────
   timeline.ts  —  D3.js 제어 응답 타임라인
   W4 구현 예정: RPM 꺾은선 + 이상 이벤트 마커
   현재: placeholder 렌더링
───────────────────────────────────────────────────────── */

export function initTimeline(container: HTMLElement): void {
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                height:100%;color:#8b949e;font-family:monospace;gap:8px;">
      <div style="font-size:32px;">📈</div>
      <div style="font-size:12px;">제어 응답 타임라인</div>
      <div style="font-size:11px;">RPM 꺾은선 + 이상 이벤트 마커</div>
      <div style="font-size:10px;padding:2px 8px;border-radius:4px;background:#21262d;color:#58a6ff;">
        W4 구현 예정
      </div>
    </div>`;
}

// W4에서 이 함수를 구현 — applyState() 호출 시마다 기록
export function updateTimeline(_severity: Severity, _rpm: number): void {
  // TODO W4: D3.js line chart에 (ts, rpm) 포인트 추가 + severity 마커
}
