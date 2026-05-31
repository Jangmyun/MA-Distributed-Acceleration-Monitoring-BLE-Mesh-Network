import './style.css';
import { MotorSim, SEVERITY_RPM } from './motor/MotorSim';
import { WsClient, getWorstSeverity } from './ws/wsClient';
import { initTopology, updateTopology } from './panels/topology';
import { initSpectrum, updateSpectrum } from './panels/spectrum';
import { initTimeline, updateTimeline } from './panels/timeline';
import type { DashboardState, Severity } from './types';

/* ─────────────────────────────────────────────────────────
   main.ts  —  대시보드 진입점
   역할: DOM 마운트 / MotorSim 초기화 / WsClient 연결 /
         시나리오 버튼 핸들러 / UI 갱신 루프
───────────────────────────────────────────────────────── */

// ── DOM 템플릿 주입 ──────────────────────────────────────
document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <!-- 상단 컨트롤 바 -->
  <header id="header">
    <h1>BLE Mesh Vibration Monitor</h1>
    <span class="label">시나리오:</span>
    <button class="scenario-btn active-normal"  id="btn-normal"   data-scenario="normal">정상 운전</button>
    <button class="scenario-btn"               id="btn-warning"  data-scenario="warning">불균형 부하</button>
    <button class="scenario-btn"               id="btn-critical" data-scenario="critical">베어링 마모</button>
    <div id="rpm-display">현재 RPM: <span id="rpm-val">0</span></div>
    <div id="ws-status">
      <div id="ws-dot"></div>
      <span id="ws-text">WebSocket 미연결</span>
    </div>
  </header>

  <!-- 4패널 그리드 -->
  <main id="main">
    <!-- 패널 1: D3 토폴로지 (W2) -->
    <section class="panel">
      <div class="panel-title">
        BLE Mesh 토폴로지
        <span class="badge">D3.js Force Graph</span>
      </div>
      <div class="panel-body" id="panel-topology"></div>
    </section>

    <!-- 패널 2: Three.js 모터 (W1) -->
    <section class="panel">
      <div class="panel-title">
        3D 모터 시뮬레이터
        <span class="badge">Three.js</span>
      </div>
      <div class="panel-body motor-wrap" id="panel-motor">
        <canvas id="motor-canvas"></canvas>
        <div id="severity-overlay">
          <div id="severity-dot"></div>
          <span id="severity-text">NORMAL</span>
        </div>
        <div id="target-rpm-overlay">목표: <span id="target-rpm-val">1200</span> RPM</div>
      </div>
    </section>

    <!-- 패널 3: D3 스펙트럼 (W3) -->
    <section class="panel">
      <div class="panel-title">
        FFT 스펙트럼
        <span class="badge">D3.js Bar Chart</span>
      </div>
      <div class="panel-body" id="panel-spectrum"></div>
    </section>

    <!-- 패널 4: D3 타임라인 (W4) -->
    <section class="panel">
      <div class="panel-title">
        제어 응답 타임라인
        <span class="badge">D3.js Line Chart</span>
      </div>
      <div class="panel-body" id="panel-timeline"></div>
    </section>
  </main>
`;

// ── DOM refs ─────────────────────────────────────────────
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
  normal:   'NORMAL',
  warning:  'WARNING',
  critical: 'CRITICAL',
};

// ── 심각도 적용 ───────────────────────────────────────────
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

  // W4: 타임라인 갱신 (현재는 no-op)
  updateTimeline(severity, motorSim.currentRPM);
}

// ── WebSocket 콜백 ────────────────────────────────────────
function onWsStatus(connected: boolean): void {
  wsDot.classList.toggle('connected', connected);
  wsText.textContent = connected ? 'WebSocket 연결됨' : 'WebSocket 미연결';
}

function onWsState(state: DashboardState): void {
  const severity = getWorstSeverity(state.nodes);
  applyState(severity);
  updateTopology(state);  // W2: no-op
  updateSpectrum(state);  // W3: no-op
}

// ── 시나리오 버튼 ─────────────────────────────────────────
function setupButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('.scenario-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const scenario = btn.dataset.scenario as Severity;
      applyState(scenario);
      wsClient.sendScenario(scenario);
    });
  });
}

// ── UI RPM 갱신 루프 ──────────────────────────────────────
function startUiLoop(): void {
  const loop = () => {
    rpmValEl.textContent = String(Math.round(motorSim.currentRPM));
    requestAnimationFrame(loop);
  };
  loop();
}

// ── 초기화 ───────────────────────────────────────────────
const motorSim = new MotorSim(
  document.getElementById('motor-canvas') as HTMLCanvasElement,
);
const wsClient = new WsClient(onWsState, onWsStatus);

initTopology(document.getElementById('panel-topology')!);
initSpectrum(document.getElementById('panel-spectrum')!);
initTimeline(document.getElementById('panel-timeline')!);

setupButtons();
startUiLoop();
applyState('normal');
