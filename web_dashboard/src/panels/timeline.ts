import type { Severity } from '../types';

/* ─────────────────────────────────────────────────────────
   timeline.ts  —  D3.js control response timeline
   W4: RPM line chart + anomaly event markers
   Current: placeholder rendering
───────────────────────────────────────────────────────── */

export function initTimeline(container: HTMLElement): void {
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                height:100%;color:#8b949e;font-family:monospace;gap:8px;">
      <div style="font-size:32px;">📈</div>
      <div style="font-size:12px;">Control Response Timeline</div>
      <div style="font-size:11px;">RPM Line Chart + Anomaly Event Markers</div>
      <div style="font-size:10px;padding:2px 8px;border-radius:4px;background:#21262d;color:#58a6ff;">
        Planned for W4
      </div>
    </div>`;
}

// Implemented in W4 — called every time applyState() runs
export function updateTimeline(_severity: Severity, _rpm: number): void {
  // TODO W4: append (ts, rpm) point to D3.js line chart + severity marker
}
