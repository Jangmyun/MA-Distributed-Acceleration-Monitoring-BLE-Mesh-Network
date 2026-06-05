# Skill: 웹 대시보드 — Three.js + D3.js

## 언제 이 스킬을 사용하나

- Three.js 모터 시뮬레이터 (`motor_sim.js`) 코드를 작성/수정할 때
- D3.js 스펙트럼·토폴로지·타임라인 패널을 다룰 때
- WebSocket 연결 및 메시지 파싱 로직을 수정할 때
- 이상 심각도별 시각 반응(색상, 진동 이펙트, RPM)을 조정할 때
- 시나리오 주입 버튼 / 임계값 슬라이더 UI를 변경할 때

---

## 기술 스택

| 라이브러리 | 버전 | 로드 방법 |
|-----------|------|-----------|
| Three.js | r165 | CDN `unpkg.com/three@0.165.0/build/three.module.js` |
| D3.js | v7 | CDN `cdn.jsdelivr.net/npm/d3@7` |
| WebSocket | 브라우저 내장 | `new WebSocket('ws://localhost:8765')` |

> 로컬 복사본은 gitignore됨. CDN 사용 유지.

---

## WebSocket 페이로드 구조

```json
{
  "nodes": [
    {"id":"A","severity":"normal","dom_freq":48.8,"sfm":0.12,
     "rms_dev":0.03,"top8_bins":[0,0,0,1450,0,0,0,0],"rssi":-45,"online":true},
    {"id":"B","severity":"warning","dom_freq":62.5,"sfm":0.31,
     "rms_dev":0.18,"top8_bins":[0,0,0,980,0,520,0,0],"rssi":-67,"online":true},
    {"id":"C","severity":"normal","dom_freq":48.8,"sfm":0.13,
     "rms_dev":0.04,"top8_bins":[0,0,0,1420,0,0,0,0],"rssi":0,"online":true}
  ],
  "links": [
    {"src":"A","dst":"B","rssi":-52},
    {"src":"B","dst":"C","rssi":-48}
  ],
  "ts": 1735200000
}
```

---

## Three.js 모터 시뮬레이터 (`motor_sim.js`)

### 씬 구성 오브젝트

```javascript
import * as THREE from 'three';

// 지오메트리는 CylinderGeometry만 사용 (PRD §4.1)
const motorBody  = new THREE.Mesh(
  new THREE.CylinderGeometry(0.5, 0.5, 1.0, 32), matHousing);
const shaft      = new THREE.Mesh(
  new THREE.CylinderGeometry(0.05, 0.05, 2.0, 16), matShaft);
const flywheel   = new THREE.Mesh(
  new THREE.CylinderGeometry(0.8, 0.8, 0.1, 32), matDisk);
const imbalance  = new THREE.Mesh(
  new THREE.SphereGeometry(0.12, 16, 16), matImbalance); // 편심 위치
```

### 심각도별 시각 상태

```javascript
const SEVERITY_CONFIG = {
  normal:   { rpm: 1200, color: 0x22c55e, shakeAmp: 0,    imbalanceVisible: false },
  warning:  { rpm: 600,  color: 0xeab308, shakeAmp: 0.02, imbalanceVisible: true  },
  critical: { rpm: 0,    color: 0xef4444, shakeAmp: 0.08, imbalanceVisible: true  },
};
```

### RPM 제어 루프 (lerp 기반 부드러운 전환)

```javascript
class MotorSim {
  constructor() {
    this.targetRPM  = 1200;
    this.currentRPM = 1200;
    this.severity   = 'normal';
  }

  setRPM(rpm) { this.targetRPM = rpm; }

  tick(delta) {
    // 목표 RPM으로 부드럽게 수렴
    const lerpFactor = 0.05;
    this.currentRPM += (this.targetRPM - this.currentRPM) * lerpFactor;

    // 플라이휠 회전 (라디안/초)
    const angularVel = (this.currentRPM / 60) * 2 * Math.PI;
    flywheel.rotation.y += angularVel * delta;
    shaft.rotation.y    += angularVel * delta;

    // 불균형 추 공전
    const cfg = SEVERITY_CONFIG[this.severity];
    imbalance.visible = cfg.imbalanceVisible;
    flywheel.material.color.setHex(cfg.color);
  }
}
```

### 진동 이펙트 (카메라 shake)

```javascript
function applyVibrationEffect(severity, camera) {
  const amp = SEVERITY_CONFIG[severity].shakeAmp;
  if (amp === 0) {
    camera.position.set(0, 1.5, 4);  // 기본 위치 복원
    return;
  }
  camera.position.x += (Math.random() - 0.5) * amp;
  camera.position.y += (Math.random() - 0.5) * amp;
}
```

### 애니메이션 루프

```javascript
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  motorSim.tick(delta);
  applyVibrationEffect(currentSeverity, camera);
  renderer.render(scene, camera);
}
animate();
```

---

## D3.js 패널

### 패널 1 — FFT 스펙트럼 바 차트

```javascript
// top8_bins → 8개 바 (기준선 오버레이 포함)
// X축: 주파수 (Δf=3.906 Hz 간격, 가상 레이블)
// Y축: 진폭 (0 ~ 최대값 동적 스케일)
// 기준선은 회색 점선으로 오버레이

function updateSpectrum(nodeData) {
  const bins = nodeData.top8_bins;
  // d3 selection → bar height 업데이트 (transition 0.2s)
}
```

### 패널 2 — Force-directed 토폴로지

```javascript
// 노드 색: severity → { normal: '#22c55e', warning: '#eab308', critical: '#ef4444' }
// 노드 offline: '#6b7280' (회색)
// 엣지 굵기: RSSI 절대값에 반비례 (약할수록 가늘게)
// offline 노드 링크: stroke-dasharray 점선

const colorMap = {
  normal: '#22c55e', warning: '#eab308',
  critical: '#ef4444', offline: '#6b7280'
};
```

### 패널 3 — 제어 타임라인

```javascript
// X축: 시간 (슬라이딩 윈도우, 최근 60초)
// Y축: RPM (0 ~ 1400)
// 꺾은선: motorSim.currentRPM 매 프레임 기록
// 이벤트 마커: severity 변화 시점에 수직선 + 레이블

const timelineData = [];  // { ts: Date.now(), rpm: currentRPM, event?: 'warning' }

function pushTimeline(rpm, event = null) {
  timelineData.push({ ts: Date.now(), rpm, event });
  if (timelineData.length > 600) timelineData.shift();  // 60초 @ 10Hz
  redrawTimeline();
}
```

---

## WebSocket 수신 및 디스패치

```javascript
const ws = new WebSocket('ws://localhost:8765');

ws.onmessage = (event) => {
  const state = JSON.parse(event.data);
  const severity = getWorstSeverity(state.nodes);

  // Three.js 제어
  motorSim.severity = severity;
  motorSim.setRPM(SEVERITY_CONFIG[severity].rpm);

  // D3.js 패널 갱신
  updateTopologyGraph(state.nodes, state.links);
  updateSpectrumCharts(state.nodes);
  pushTimeline(motorSim.currentRPM, severity !== currentSeverity ? severity : null);

  currentSeverity = severity;
};

function getWorstSeverity(nodes) {
  if (nodes.some(n => n.severity === 'critical')) return 'critical';
  if (nodes.some(n => n.severity === 'warning'))  return 'warning';
  return 'normal';
}
```

---

## 시나리오 주입 (브라우저 → 브릿지)

```javascript
// 상단 제어 바 버튼 핸들러
document.getElementById('btn-normal').onclick = () =>
  ws.send(JSON.stringify({ type: 'inject_scenario', scenario: 'normal' }));

document.getElementById('btn-imbalance').onclick = () =>
  ws.send(JSON.stringify({ type: 'inject_scenario', scenario: 'imbalance' }));

document.getElementById('btn-bearing').onclick = () =>
  ws.send(JSON.stringify({ type: 'inject_scenario', scenario: 'bearing_wear' }));

// 임계값 슬라이더 → GATT Write (브릿지 경유)
document.getElementById('slider-sfm').oninput = (e) =>
  ws.send(JSON.stringify({ type: 'set_threshold', key: 'sfm', value: parseFloat(e.target.value) }));
```

---

## 디버깅 체크리스트

| 증상 | 확인 사항 |
|------|-----------|
| WebSocket 연결 안 됨 | `gateway_bridge.py` 실행 중인지, 포트 8765 확인 |
| 모터가 안 돌아감 | `clock.getDelta()` 값이 0인지, animate() 루프 확인 |
| RPM 변화가 없음 | `motorSim.setRPM()` 호출 여부, lerpFactor 값 확인 |
| 토폴로지 노드 위치 고정 | D3 force simulation `alpha` 값 확인, `.restart()` 호출 |
| 스펙트럼 바가 갱신 안 됨 | `updateSpectrum()` 인자로 올바른 노드 데이터 전달 여부 |
| 타임라인이 비어있음 | `pushTimeline()` 호출 주기 및 `timelineData` 배열 확인 |
| Three.js 60fps 미달 | `CylinderGeometry` segments 수 줄이기 (32→16) |
