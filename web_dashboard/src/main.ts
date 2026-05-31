import './style.css';
import { MotorSim, SEVERITY_RPM } from './motor/MotorSim';
import { WsClient, getWorstSeverity } from './ws/wsClient';
import { initTopology, updateTopology } from './panels/topology';
import { initSpectrum, updateSpectrum } from './panels/spectrum';
import { initTimeline, updateTimeline } from './panels/timeline';
import type { DashboardState, Severity } from './types';

/* ─────────────────────────────────────────────────────────
   main.ts  —  Dashboard entry point
   Responsibilities: DOM mount / MotorSim init / WsClient connect /
                     scenario button handlers / UI update loop
───────────────────────────────────────────────────────── */

// ── DOM template ─────────────────────────────────────────
document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <!-- 상단 컨트롤 바 -->
  <header id="header">
    <h1>BLE Mesh Vibration Monitor</h1>
    <span class="label">Scenario:</span>
    <button class="scenario-btn active-normal"  id="btn-normal"   data-scenario="normal">Normal</button>
    <button class="scenario-btn"               id="btn-warning"  data-scenario="warning">Imbalance Load</button>
    <button class="scenario-btn"               id="btn-critical" data-scenario="critical">Bearing Wear</button>
    <div id="rpm-display">Current RPM: <span id="rpm-val">0</span></div>
    <div id="ws-status">
      <div id="ws-dot"></div>
      <span id="ws-text">WebSocket disconnected</span>
    </div>
  </header>

  <!-- 4패널 그리드 -->
  <main id="main">
    <!-- Panel 1: D3 Topology (W2) -->
    <section class="panel">
      <div class="panel-title">
        BLE Mesh Topology
        <span class="badge">D3.js Force Graph</span>
      </div>
      <div class="panel-body" id="panel-topology"></div>
    </section>

    <!-- Panel 2: Three.js Motor Simulator (W1) -->
    <section class="panel">
      <div class="panel-title">
        3D Motor Simulator
        <span class="badge">Three.js</span>
      </div>
      <div class="panel-body motor-wrap" id="panel-motor">
        <canvas id="motor-canvas"></canvas>
        <div id="severity-overlay">
          <div id="severity-dot"></div>
          <span id="severity-text">NORMAL</span>
        </div>
        <div id="target-rpm-overlay">Target: <span id="target-rpm-val">1200</span> RPM</div>
      </div>
    </section>

    <!-- Panel 3: D3 FFT Spectrum (W3) -->
    <section class="panel">
      <div class="panel-title">
        FFT Spectrum
        <span class="badge">D3.js Bar Chart</span>
      </div>
      <div class="panel-body" id="panel-spectrum"></div>
    </section>

    <!-- Panel 4: D3 Timeline (W4) -->
    <section class="panel">
      <div class="panel-title">
        Control Response Timeline
        <span class="badge">D3.js Line Chart</span>
      </div>
      <div class="panel-body" id="panel-timeline"></div>
    </section>
  </main>
`;

// ── DOM refs ──────────────────────────────────────────────
const rpmValEl    = document.getElementById('rpm-val')!;
const targetRpmEl = document.getElementById('target-rpm-val')!;
const severityDot = document.getElementById('severity-dot')!;
const severityTxt = document.getElementById('severity-text')!;
const wsDot       = document.getElementById('ws-dot')!;
const wsText      = document.getElementById('ws-text')!;

const SEVERITY_COLOR: Record<Severity, string> = {
  normal:   'var(--col-normal)',
  warning:  'var(--col-warning)',
  critical: 'var(--col-critical)',
};
const SEVERITY_LABEL: Record<Severity, string> = {
  normal:   'Normal',
  warning:  'Warning',
  critical: 'Critical',
};

// ── Apply severity ────────────────────────────────────────
function applyState(severity: Severity): void {
  const rpm = SEVERITY_RPM[severity];
  motorSim.setSeverity(severity);
  motorSim.setRPM(rpm);

  severityDot.style.background = SEVERITY_COLOR[severity];
  severityTxt.textContent      = SEVERITY_LABEL[severity];
  severityTxt.style.color      = SEVERITY_COLOR[severity];
  targetRpmEl.textContent      = String(rpm);

  (['normal', 'warning', 'critical'] as Severity[]).forEach(s => {
    const btn = document.getElementById(`btn-${s}`)!;
    btn.className = `scenario-btn${s === severity ? ` active-${s}` : ''}`;
  });

  // W4: update timeline (no-op for now)
  updateTimeline(severity, motorSim.currentRPM);
}

// ── WebSocket callbacks ───────────────────────────────────
function onWsStatus(connected: boolean): void {
  wsDot.classList.toggle('connected', connected);
  wsText.textContent = connected ? 'WebSocket connected' : 'WebSocket disconnected';
}

function onWsState(state: DashboardState): void {
  const severity = getWorstSeverity(state.nodes);
  applyState(severity);
  updateTopology(state);  // W2: no-op → D3 force graph
  updateSpectrum(state);  // W3: no-op → D3 bar chart
}

// ── Scenario buttons ──────────────────────────────────────
function setupButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('.scenario-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const scenario = btn.dataset.scenario as Severity;
      applyState(scenario);
      wsClient.sendScenario(scenario);
    });
  });
}

// ── UI RPM update loop ────────────────────────────────────
function startUiLoop(): void {
  const loop = () => {
    rpmValEl.textContent = String(Math.round(motorSim.currentRPM));
    requestAnimationFrame(loop);
  };
  loop();
}

// ── Initialisation ────────────────────────────────────────
const motorSim = new MotorSim(
  document.getElementById('motor-canvas') as HTMLCanvasElement,
);
const wsClient = new WsClient(onWsState, onWsStatus);

initTopology(document.getElementById('panel-topology')!);
initSpectrum(document.getElementById('panel-spectrum')!);
initTimeline(document.getElementById('panel-timeline')!);

setupButtons();
startUiLoop();
applyState('normal');  // Initial state: normal operation at 1200 RPM
