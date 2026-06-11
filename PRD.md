# PRD: BLE Mesh 분산 가속도 모니터링 + Three.js 모터 각도 실시간 시각화

> **과목:** 마이크로프로세서 응용 (기말 프로젝트)
> **버전:** v1.0
> **작성일:** 2026-06-11

---

## 1. 프로젝트 개요

### 1.1 한 줄 요약

세 대의 nRF52840 DK가 BLE Mesh로 ADXL345 가속도 데이터를 분산 수집하고,
각 노드의 기울기(Roll/Pitch 각도)를 WebSocket을 통해 브라우저로 전달하여
Three.js 3D 모터 시뮬레이터가 센서 각도를 실시간으로 추종한다.

### 1.2 목표

- ADXL345 X/Y/Z 가속도 → Roll/Pitch 각도 계산 → BLE Mesh publish
- 3노드 각도 데이터를 Gateway에서 집계 → GATT Notify → WebSocket 브로드캐스트
- 브라우저 Three.js 모터 어셈블리가 측정된 각도를 실시간 추종
- D3.js 토폴로지 그래프로 Mesh 노드 연결 상태 시각화

### 1.3 수업 외 기술

| # | 기술 | 적용 위치 |
|---|------|-----------|
| ① | ADXL345 Roll/Pitch 각도 연산 (atan2 기반) | nRF52840 펌웨어 또는 Python 브릿지 |
| ② | Three.js 3D 물리 시뮬레이션 — 센서 각도 실시간 추종 | 웹 대시보드 |

---

## 2. 시스템 아키텍처

```
[Node A]──BLE Mesh──[Node B: Relay]──BLE Mesh──[Node C: GW]
ADXL345              ADXL345                   ADXL345
이벤트 publish        이벤트 publish + relay     UART 출력
                                                  │
          BLE GATT Notify (미구현, ❌)             │  UART Serial (권장, ✅)
          또는                                     │  ACCEL:A/B/C:x,y,z
          ──────────────────────────────────────────┘
                                                  │
                                                  ▼
                                     gateway_bridge.py  →  WebSocket (:8765)
                                             │
                                             │  ws://localhost:8765
                                             ▼
                                     웹 대시보드 (web_dashboard/)
                                       ├─ Three.js: 3D 모터 — 센서 각도 추종
                                       └─ D3.js:   BLE Mesh 토폴로지 그래프
```

### 2.1 하드웨어

| 항목 | 사양 |
|------|------|
| SoC / 보드 | nRF52840 (Cortex-M4F) / nRF52840-DK × 3 |
| 센서 | ADXL345 (I2C 0x53, P0.26 SDA / P0.27 SCL) |
| 디스플레이 | LCD 1602 (PCF8574 I2C 백팩 0x27, 동일 버스) |

### 2.2 노드 역할

| 노드 | 역할 |
|------|------|
| Node A | Sensor + BLE Mesh publish (이벤트 기반, 최대 1Hz) |
| Node B | Sensor + BLE Mesh publish + Relay |
| Node C | Sensor + Mesh 집계 + UART 출력 (`ACCEL:id:x,y,z`) → bridge fallback |

> Node C GATT Server는 미구현 상태. 현재 UART Serial을 통해 bridge로 데이터 전달한다.

### 2.3 디렉토리 구조

```
project-root/
├── .claude/
│   ├── CLAUDE.md
│   ├── skills/
│   ├── hooks/
│   └── settings.json
├── ble_node_nrf52840_dk/          ← 단일 펌웨어 (Node A/B/C 공통 빌드)
│   ├── src/
│   │   ├── main.c                 ← 센서 폴링 + 이벤트 publish + LCD + UART fallback
│   │   ├── model_handler.c        ← Chat CLI Vendor Model + ACCEL 파싱 + UART 출력
│   │   ├── lcd1602.c / lcd1602.h
│   │   └── chat_cli.c
│   ├── prj.conf
│   └── boards/nrf52840dk_nrf52840.overlay
├── bridge/
│   ├── gateway_bridge.py          ← --serial / --addr / --mock 3가지 모드
│   └── requirements.txt
└── web_dashboard/
    ├── index.html
    ├── src/
    │   ├── main.ts                ← 2패널 레이아웃 + 노드 선택 버튼
    │   ├── types.ts               ← NodeState / MeshLink / DashboardState 타입
    │   ├── motor/MotorSim.ts      ← Three.js 3D 모터 + setAngle() + lerp
    │   ├── panels/topology.ts     ← D3.js Force Graph
    │   └── ws/wsClient.ts         ← WebSocket 클라이언트 (자동 재연결)
    └── package.json
```

---

## 3. 각도 계산

ADXL345 X/Y/Z 가속도(단위: m/s², centiunits 정수)로부터 기울기 각도를 계산한다.

```
roll  (X축 기울기) = atan2(y, z)          × (180 / π)
pitch (Y축 기울기) = atan2(-x, √(y²+z²)) × (180 / π)
```

계산 위치는 **Python 브릿지**에서 수행한다 (펌웨어 부하 최소화).
펌웨어는 기존 `"A:x_centi,y_centi,z_centi"` 텍스트 포맷으로 publish한다.

---

## 4. 데이터 흐름

### 4.1 BLE Mesh 페이로드 (펌웨어 → 펌웨어)

Chat CLI Vendor Model 텍스트 메시지:

```
"A:<x_centi>,<y_centi>,<z_centi>"
예) "A:123,-234,981"  →  x=1.23 m/s², y=-2.34 m/s², z=9.81 m/s²
```

### 4.2 Node C → PC 인터페이스

**현재 구현 (UART fallback, ✅):**

Node C 펌웨어가 UART로 아래 형식을 출력한다. bridge가 두 형식을 모두 파싱한다.

```
# 형식 1 — 단순 라인 (현재 펌웨어 출력)
ACCEL:C:10,-20,975     ← 자기 자신 (GW_UART_INTERVAL_MS=1000ms마다)
ACCEL:A:123,-234,981   ← Node A 수신 시 (model_handler handle_chat_message)
ACCEL:B:50,100,960     ← Node B 수신 시

# 형식 2 — JSON 한 줄 (GATT Server 구현 후 또는 펌웨어 업그레이드 시)
{"nodes":[...],"links":[...]}
```

노드 주소 → ID 매핑 (펌웨어 하드코딩):
- Unicast 0x0001 → A
- Unicast 0x0002 → B
- 자기 자신 → C

**미구현 (GATT Server, ❌):**

```json
{
  "nodes": [
    { "id": "A", "x": 123, "y": -234, "z": 981, "online": true, "rssi": -45 },
    { "id": "B", "x":  50, "y":  100, "z": 960, "online": true, "rssi": -62 },
    { "id": "C", "x":  10, "y":  -20, "z": 975, "online": true, "rssi": 0   }
  ],
  "links": [
    { "src": "A", "dst": "B", "rssi": -52 },
    { "src": "B", "dst": "C", "rssi": -48 }
  ],
  "ts": 1735200000
}
```

### 4.3 WebSocket 페이로드 (bridge → 브라우저)

브릿지가 roll/pitch를 계산하여 추가:

```json
{
  "nodes": [
    { "id": "A", "x": 123, "y": -234, "z": 981,
      "roll": 13.5, "pitch": -0.7, "online": true, "rssi": -45 },
    ...
  ],
  "links": [...],
  "ts": 1735200000
}
```

---

## 5. 컴포넌트 명세

### 5.1 펌웨어 (`ble_node_nrf52840_dk/` — A/B/C 공통 단일 빌드)

**구현 완료:**
- ADXL345 I2C 폴링 (200ms 주기, `POLL_INTERVAL_MS=200`)
- 이벤트 기반 BLE Mesh publish: 어느 축이든 0.05 m/s² 초과 변화 시 즉시 전송, 최대 1Hz (`PUB_INTERVAL_MS=1000`)
- Chat CLI Vendor Model `"A:x_centi,y_centi,z_centi"` BLE Mesh publish / 수신
- LCD 1602: Line0 로컬 X/Y, Line1 원격 노드 주소 + X
- OOB 프로비저닝 + Flash 설정 복원
- `CONFIG_BT_MESH_RELAY=y`, `CONFIG_BT_MESH_GATT_PROXY=y`
- SAR 버퍼 안정화: `TX/RX_SEG_MSG_COUNT=4`, `TX/RX_SEG_MAX=9`, `ADV_BUF_COUNT=24`
- **Gateway UART fallback (Node C용):**
  - 자기 자신 데이터를 `ACCEL:C:x,y,z` 형식으로 1초마다 UART 출력
  - 수신 메시지를 `ACCEL:A/B:x,y,z` 형식으로 UART 출력 (0x0001→A, 0x0002→B)

**미구현:**
- Node C: GATT Server (`bfbc1234-...` Service, `bfbc1235-...` Notify Characteristic)
  - 현재 UART fallback으로 대체 운용 중

### 5.2 LCD 표시

```
Line 0: X= +01.23  Y= -02.34
Line 1: R:0002 X +01.23
```

미프로비전: `Mesh: no prov  `
수신 대기:  `Mesh: waiting..`

### 5.3 Python 브릿지 (`bridge/gateway_bridge.py`) ✅ 구현 완료

**입력 소스 (3가지 상호 배타적):**
```bash
python gateway_bridge.py --serial /dev/cu.usbmodemXXXX   # UART (권장)
python gateway_bridge.py --addr AA:BB:CC:DD:EE:FF         # BLE GATT (Node C GATT 구현 후)
python gateway_bridge.py --mock                           # 더미 데이터 (하드웨어 없이 테스트)
```

**핵심 기능:**
- Roll/Pitch 계산 (`calc_angles()`: centiunits → degrees)
- 이동평균 필터 (n=3, `MovingAverage` 클래스)
- 15초 미수신 노드 `online: false` 처리 (`NodeTracker`)
- 신규 WS 연결 시 마지막 상태 즉시 전송 (대시보드 초기 렌더링)
- BLE 자동 재연결 (`BLE_RECONNECT_DELAY=3.0s`)
- UART: JSON 한 줄 + `ACCEL:id:x,y,z` 단순 라인 두 형식 모두 지원
- Mock: Node A 좌우 기울기 ±30° / Node B 앞뒤 기울기 ±20° sinusoidal

의존성: `bleak==0.21.1`, `websockets>=12.0`, `pyserial>=3.5` (`pip install -r requirements.txt`)

### 5.4 웹 대시보드 (`web_dashboard/`)

**패널 구성 (2패널로 축소):**

| 패널 | 기술 | 내용 |
|------|------|------|
| 좌 | D3.js | Force-directed BLE Mesh 토폴로지. 노드 색 = 온라인/오프라인, 엣지 굵기 = RSSI |
| 우 | Three.js | 3D 모터 어셈블리. 모터 기울기 = 선택된 노드의 Roll/Pitch 실시간 추종 |

**Three.js 모터 각도 추종:**
- `motorSim.setAngle(roll, pitch)` API 추가
- 모터 `rotatingGroup.rotation.z = roll_rad`, `rotation.x = pitch_rad`
- lerp로 부드럽게 수렴 (α = 0.1 per frame)
- 상단 바: 노드 선택 버튼 A / B / C → 해당 노드 각도 추종

**WebSocket 상태:**
- 연결 중: 연결 상태 인디케이터 (dot + 텍스트) 표시
- 수신 시: 선택 노드의 roll/pitch를 `motorSim.setAngle()`로 전달, 토폴로지 갱신
- 신규 접속 시 브릿지가 마지막 상태를 즉시 전송 (초기 렌더링 보장)
- 5초마다 자동 재연결

---

## 6. 개발 일정

| 우선순위 | 작업 | 담당 | 상태 |
|----------|------|------|------|
| 1 | Node C GATT Server — 집계 JSON Notify Characteristic 구현 | 펌웨어 | ❌ (UART fallback으로 대체) |
| 2 | `bridge/gateway_bridge.py` — BLE GATT/UART 수신 + Roll/Pitch + WS | 브릿지 | ✅ |
| 3 | `MotorSim.ts` — `setAngle(roll, pitch)`, lerp 기울기 추종 | 웹 | ✅ |
| 4 | `wsClient.ts` / `main.ts` — 노드 선택 버튼 + `setAngle()` 연동 | 웹 | ✅ |
| 5 | `topology.ts` — D3.js Force Graph (노드 온라인 상태 + RSSI 링크) | 웹 | ✅ |
| 6 | 3노드 실물 End-to-End 검증 | 통합 | ❌ |

---

## 7. 데모 시나리오 (발표 5분)

1. **인트로 (30초):** 3노드 배치 + 브라우저 대시보드 (토폴로지 + 3D 모터) 표시
2. **정상 평치 (1분):** 센서 수평 → 모터 수직 정렬 확인
3. **Node A 기울기 (1분):** Node A 센서를 손으로 기울임 → 브라우저 모터가 실시간 추종
4. **노드 전환 (1분):** 노드 선택 버튼 A→B→C 전환 → 각 노드 각도로 모터 전환
5. **Node B 오프라인 (30초):** Node B 전원 차단 → 토폴로지 그래프에서 회색 처리
6. **마무리 (1분):** BLE Mesh 자율 네트워크 + 실시간 센서 → 3D 피드백 의의

---

## 8. 위험 요소 및 대응

| 위험 | 대응책 | 상태 |
|------|--------|------|
| Node C GATT 구현 지연 | 브릿지 UART fallback (`--serial`) | ✅ 대응 완료 |
| BLE GATT 연결 지연 > 200ms | 데모 허용 범위로 완화; 발표에서 지연 명시 | — |
| 각도 노이즈 (정적 가속도 외 진동) | 브릿지 이동평균 필터 (n=3) | ✅ 구현 완료 |
| bleak macOS BLE 권한 오류 | `pip install bleak` 및 Bluetooth 권한 사전 확인 | — |
| UART 노드 ID 오매핑 | 주소 0x0001→A, 0x0002→B 하드코딩 확인 필요 | ⚠️ 프로비저닝 주소 의존 |

---

## 9. 진행 현황 (2026-06-11)

> 범례: ✅ 완료 · 🔧 부분 구현 · ❌ 미착수

| 컴포넌트 | 항목 | 상태 |
|----------|------|------|
| 펌웨어 | ADXL345 I2C 폴링 (200ms) + 이벤트 기반 BLE Mesh publish | ✅ |
| 펌웨어 | LCD 1602 로컬·원격 표시 | ✅ |
| 펌웨어 | OOB 프로비저닝 + Flash 복원 | ✅ |
| 펌웨어 | SAR 버퍼 안정화 (`TX/RX_SEG_MSG_COUNT=4`, `ADV_BUF_COUNT=24`) | ✅ |
| 펌웨어 | Gateway UART fallback (`ACCEL:id:x,y,z` 출력) | ✅ |
| 펌웨어 | Node C GATT Server (집계 Notify) | ❌ |
| 브릿지 | `gateway_bridge.py` UART/BLE/Mock + Roll/Pitch + WS | ✅ |
| 브릿지 | 이동평균 필터 (n=3), 오프라인 타임아웃 (15s) | ✅ |
| 웹 | Three.js 3D 모터 (`MotorSim.ts`) | ✅ |
| 웹 | Three.js `setAngle(roll, pitch)` lerp 각도 추종 | ✅ |
| 웹 | WebSocket 클라이언트 `wsClient.ts` (자동 재연결) | ✅ |
| 웹 | 2패널 레이아웃 + 노드 선택 버튼 A/B/C (`main.ts`) | ✅ |
| 웹 | D3.js 토폴로지 — 노드 온라인/오프라인 + RSSI 링크 | ✅ |
| 웹 | D3.js 스펙트럼 / 타임라인 패널 | 제거 (범위 축소) |
| 통합 | 3노드 실물 End-to-End 검증 | ❌ |
