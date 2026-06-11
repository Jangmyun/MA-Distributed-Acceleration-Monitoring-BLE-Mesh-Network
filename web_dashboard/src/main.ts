import './style.css';
import { MotorSim }           from './motor/MotorSim';
import { WsClient }           from './ws/wsClient';
import { initTopology, updateTopology } from './panels/topology';
import type { DashboardState } from './types';

/* ─────────────────────────────────────────────────────────
   main.ts  —  Dashboard entry point  (PRD §5.4)
   Layout  : 2 panels — D3 Topology (left) + Three.js Motor (right)
   Header  : title + Node A/B/C selector + WS status indicator
   Data    : WsClient → updateTopology() + motorSim.setAngle(roll, pitch)
───────────────────────────────────────────────────────── */

// ── DOM ──────────────────────────────────────────────────
document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header id="header">
    <h1>BLE Mesh Accel Monitor</h1>
    <span class="label">Node:</span>
    <button class="node-btn active" id="btn-A" data-node="A">A</button>
    <button class="node-btn"        id="btn-B" data-node="B">B</button>
    <button class="node-btn"        id="btn-C" data-node="C">C</button>
    <div id="ws-status">
      <div id="ws-dot"></div>
      <span id="ws-text">disconnected</span>
    </div>
  </header>

  <main id="main">
    <!-- Panel 1: D3 BLE Mesh Topology -->
    <section class="panel">
      <div class="panel-title">
        BLE Mesh Topology
        <span class="badge">D3.js Force Graph</span>
      </div>
      <div class="panel-body" id="panel-topology"></div>
    </section>

    <!-- Panel 2: Three.js Motor Angle Sim -->
    <section class="panel">
      <div class="panel-title">
        3D Motor Simulator
        <span class="badge">Three.js</span>
      </div>
      <div class="panel-body motor-wrap" id="panel-motor">
        <canvas id="motor-canvas"></canvas>
        <div id="angle-overlay">
          <div id="angle-node-label">Node A</div>
          <div class="angle-row">
            <span class="angle-key">Roll</span>
            <span id="angle-roll" class="angle-val">0.0</span>°
          </div>
          <div class="angle-row">
            <span class="angle-key">Pitch</span>
            <span id="angle-pitch" class="angle-val">0.0</span>°
          </div>
        </div>
      </div>
    </section>
  </main>
`;

// ── DOM refs ──────────────────────────────────────────────
const wsDot         = document.getElementById('ws-dot')!;
const wsText        = document.getElementById('ws-text')!;
const angleNodeEl   = document.getElementById('angle-node-label')!;
const angleRollEl   = document.getElementById('angle-roll')!;
const anglePitchEl  = document.getElementById('angle-pitch')!;

// ── State ─────────────────────────────────────────────────
let selectedNode = 'A';

// ── Motor ─────────────────────────────────────────────────
const motorSim = new MotorSim(
  document.getElementById('motor-canvas') as HTMLCanvasElement,
);

// ── Node selector buttons ─────────────────────────────────
document.querySelectorAll<HTMLButtonElement>('.node-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    selectedNode = btn.dataset.node!;
    document.querySelectorAll<HTMLButtonElement>('.node-btn')
      .forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    angleNodeEl.textContent = `Node ${selectedNode}`;
  });
});

// ── WebSocket callbacks ───────────────────────────────────
function onWsStatus(connected: boolean): void {
  wsDot.classList.toggle('connected', connected);
  wsText.textContent = connected ? 'connected' : 'disconnected';
}

function onWsState(state: DashboardState): void {
  // D3 topology update
  updateTopology(state);

  // Motor angle update for selected node
  const node = state.nodes.find(n => n.id === selectedNode);
  if (node?.online) {
    motorSim.setAngle(node.roll, node.pitch);
    angleRollEl.textContent  = (node.roll  >= 0 ? '+' : '') + node.roll.toFixed(1);
    anglePitchEl.textContent = (node.pitch >= 0 ? '+' : '') + node.pitch.toFixed(1);
  }
}

// ── Init ──────────────────────────────────────────────────
initTopology(document.getElementById('panel-topology')!);
new WsClient(onWsState, onWsStatus);
