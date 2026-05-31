import type { DashboardState } from '../types';

/* ─────────────────────────────────────────────────────────
   spectrum.ts  —  D3.js FFT spectrum bar chart
   W3: 3-node top8_bins + baseline overlay
   Current: placeholder rendering
───────────────────────────────────────────────────────── */

export function initSpectrum(container: HTMLElement): void {
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                height:100%;color:#8b949e;font-family:monospace;gap:8px;">
      <div style="font-size:32px;">📊</div>
      <div style="font-size:12px;">FFT Spectrum</div>
      <div style="font-size:11px;">3-node Bar Chart + Baseline Overlay</div>
      <div style="font-size:10px;padding:2px 8px;border-radius:4px;background:#21262d;color:#58a6ff;">
        Planned for W3
      </div>
    </div>`;
}

// Implemented in W3 — called from wsClient.onState callback
export function updateSpectrum(_state: DashboardState): void {
  // TODO W3: update top8_bins via D3.js bar chart + baseline overlay
}
