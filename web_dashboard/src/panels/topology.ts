import type { DashboardState } from '../types';

/* ─────────────────────────────────────────────────────────
   topology.ts  —  D3.js Force-directed topology graph
   W2: BLE Mesh node/link visualisation
   Current: placeholder rendering
───────────────────────────────────────────────────────── */

export function initTopology(container: HTMLElement): void {
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                height:100%;color:#8b949e;font-family:monospace;gap:8px;">
      <div style="font-size:32px;">🔗</div>
      <div style="font-size:12px;">BLE Mesh Topology</div>
      <div style="font-size:11px;">Force-directed Graph</div>
      <div style="font-size:10px;padding:2px 8px;border-radius:4px;background:#21262d;color:#58a6ff;">
        Planned for W2
      </div>
    </div>`;
}

// Implemented in W2 — called from wsClient.onState callback
export function updateTopology(_state: DashboardState): void {
  // TODO W2: update nodes/links via D3.js force simulation
}
