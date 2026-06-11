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
각도 계산 + publish   각도 계산 + publish        집계 + GATT Notify
     │
     │  BLE GATT (Custom Notify)
     ▼
gateway_bridge.py  →  WebSocket (:8765)
     │
     │  ws://localhost:8765
     ▼
웹 대시보드 (index.html)
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
| Node A | Sensor + BLE Mesh publish |
| Node B | Sensor + BLE Mesh publish + Relay |
| Node C | Sensor + Mesh 집계 + GATT Server |

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

### 4.2 GATT Notify 페이로드 (Node C → PC)

Node C가 집계 후 JSON으로 직렬화하여 Notify:

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

### 5.1 펌웨어 (Node A / B 공통, `ble_node_nrf52840_dk/`)

**현재 구현 완료:**
- ADXL345 I2C 폴링 (1000ms 주기)
- Chat CLI Vendor Model `"A:x,y,z"` BLE Mesh publish / 수신
- LCD 1602: Line0 로컬 X/Y, Line1 원격 노드 주소 + X
- OOB 프로비저닝 + Flash 설정 복원
- `CONFIG_BT_MESH_RELAY=y` (Node B 역할)
- `CONFIG_BT_MESH_RX_SEG_MSG_COUNT=4` (SAR 버퍼 안정화)

**추가 구현 필요:**
- Node C: GATT Server (Spectrum Aggregation Notify Characteristic)
  - 수신한 모든 노드의 최신 x/y/z + RSSI를 JSON으로 직렬화 → Notify
  - 15초 이상 미수신 노드는 `"online": false` 처리

### 5.2 LCD 표시

```
Line 0: X= +01.23  Y= -02.34
Line 1: R:0002 X +01.23
```

미프로비전: `Mesh: no prov  `
수신 대기:  `Mesh: waiting..`

### 5.3 Python 브릿지 (`bridge/gateway_bridge.py`)

```python
async def main():
    ble   = await BleakClient(GATEWAY_ADDR).connect()
    ws_sv = await websockets.serve(ws_handler, '0.0.0.0', 8765)

    async def on_notify(_, data):
        state = json.loads(data)
        for node in state['nodes']:
            x, y, z = node['x'] / 100, node['y'] / 100, node['z'] / 100
            node['roll']  = math.degrees(math.atan2(y, z))
            node['pitch'] = math.degrees(math.atan2(-x, math.sqrt(y**2 + z**2)))
        await ws_broadcast(json.dumps(state))

    ble.start_notify(NOTIFY_CHAR_UUID, on_notify)
    await asyncio.gather(ws_sv.wait_closed())
```

의존성: `bleak==0.21`, `websockets` (`pip install -r requirements.txt`)

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
- 연결 중: 연결 상태 인디케이터 표시
- 수신 시: 선택 노드의 roll/pitch를 `motorSim.setAngle()`로 전달, 토폴로지 갱신

---

## 6. 개발 일정 (잔여)

| 우선순위 | 작업 | 담당 |
|----------|------|------|
| 1 | Node C GATT Server — 집계 JSON Notify Characteristic 구현 | 펌웨어 |
| 2 | `bridge/gateway_bridge.py` — BLE GATT 수신 + Roll/Pitch 계산 + WS 브로드캐스트 | 브릿지 |
| 3 | `MotorSim.ts` — `setAngle(roll, pitch)` 추가, lerp 기울기 추종 | 웹 |
| 4 | `wsClient.ts` / `main.ts` — 노드 선택 버튼 + `setAngle()` 연동 | 웹 |
| 5 | `topology.ts` — D3.js Force Graph (노드 온라인 상태 + RSSI 링크) | 웹 |
| 6 | 3노드 실물 End-to-End 검증 | 통합 |

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

| 위험 | 대응책 |
|------|--------|
| Node C GATT 구현 지연 | 브릿지가 Node C UART 출력을 직접 파싱하는 fallback |
| BLE GATT 연결 지연 > 200ms | 데모 허용 범위로 완화; 발표에서 지연 명시 |
| 각도 노이즈 (정적 가속도 외 진동) | 브릿지에서 단순 이동평균(n=3) 적용 |
| bleak macOS BLE 권한 오류 | `! bleak` 설치 및 Bluetooth 권한 사전 확인 |

---

## 9. 진행 현황 (2026-06-11)

> 범례: ✅ 완료 · 🔧 부분 구현 · ❌ 미착수

| 컴포넌트 | 항목 | 상태 |
|----------|------|------|
| 펌웨어 | ADXL345 I2C 폴링 + BLE Mesh publish/수신 | ✅ |
| 펌웨어 | LCD 1602 로컬·원격 표시 | ✅ |
| 펌웨어 | OOB 프로비저닝 + Flash 복원 | ✅ |
| 펌웨어 | SAR RX 버퍼 안정화 (`RX_SEG_MSG_COUNT=4`) | ✅ |
| 펌웨어 | Node C GATT Server (집계 Notify) | ❌ |
| 브릿지 | `gateway_bridge.py` (BLE → WS + Roll/Pitch) | ❌ |
| 웹 | Three.js 3D 모터 (씬·회전·severity 시각) | ✅ |
| 웹 | WebSocket 클라이언트 (`wsClient.ts`) | ✅ |
| 웹 | 4패널 레이아웃 + 시나리오 버튼 (`main.ts`) | 🔧 노드 선택 버튼 교체 필요 |
| 웹 | Three.js `setAngle()` 각도 추종 | ❌ |
| 웹 | D3.js 토폴로지 (`topology.ts`) | ❌ |
| 웹 | D3.js 스펙트럼 / 타임라인 패널 | 제거 (범위 축소) |
