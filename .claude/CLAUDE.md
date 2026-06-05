# BLE Mesh 분산 진동 모니터링 — Claude Code 컨텍스트

## 프로젝트 한 줄 요약

nRF52840 × 3노드가 BLE Mesh로 MPU-6050 진동 데이터를 분산 수집 → 각 노드에서 256-point FFT + 이상 감지 → WebSocket → Three.js 3D 모터 시뮬레이터 피드백 제어.

---

## 하드웨어

| 항목             | 사양                                                            |
| ---------------- | --------------------------------------------------------------- |
| SoC              | nRF52840 (Cortex-M4F, 256 KB RAM, 1 MB Flash)                   |
| 보드             | nRF52840-DK (PCA10056) × 3                                      |
| 센서             | MPU-6050 (I2C, 400 kHz Fast Mode)                               |
| 레지스터 맵 참조 | `nrf52840.svd`                                                  |
| SoC DTS          | `zephyr/dts/arm/nordic/nrf52840.dtsi`                           |
| 보드 DTS         | `zephyr/boards/arm/nrf52840dk_nrf52840/nrf52840dk_nrf52840.dts` |

---

## SDK / 툴체인

| 항목                  | 버전                                     |
| --------------------- | ---------------------------------------- |
| nRF Connect SDK (NCS) | v2.4.x                                   |
| Zephyr RTOS           | 3.3.x                                    |
| west                  | 1.2.x                                    |
| 툴체인                | Zephyr SDK 0.16.x (arm-zephyr-eabi)      |
| CMSIS-DSP             | arm_rfft_fast_f32 — `CONFIG_CMSIS_DSP=y` |

---

## 노드 역할

| 노드   | 타겟                  | 역할                              |
| ------ | --------------------- | --------------------------------- |
| Node A | `nrf52840dk/nrf52840` | Sensor Node (FFT + Mesh publish)  |
| Node B | `nrf52840dk/nrf52840` | Sensor Node + Relay               |
| Node C | `nrf52840dk/nrf52840` | Gateway (Mesh 집계 + GATT Server) |

---

## 빌드 커맨드

```bash
# 개별 노드 빌드 (node_a / node_b / node_c 디렉토리에서)
west build -b nrf52840dk/nrf52840

# 디버그 오버레이 포함
west build -b nrf52840dk/nrf52840 -- -DOVERLAY_CONFIG=overlay-debug.conf

# 플래시 (J-Link)
west flash --runner jlink

# Kconfig GUI 확인
west build -t menuconfig

# 빌드 산출물 .config 위치
build/zephyr/.config
```

---

## 디렉토리 구조

```
project-root/
├── .claude/
│   ├── CLAUDE.md          ← 이 파일
│   ├── skills/
│   │   ├── kconfig-ref.md
│   │   ├── fft-pipeline.md
│   │   ├── ble-mesh-debug.md
│   │   └── web-dashboard.md
│   ├── hooks/
│   │   └── validate-kconfig.sh
│   └── settings.json
├── firmware/
│   ├── node_a/            ← Sensor Node A
│   ├── node_b/            ← Sensor Node B (Relay)
│   └── node_c/            ← Gateway
├── bridge/
│   ├── gateway_bridge.py
│   └── requirements.txt
└── web/
    ├── index.html
    ├── dashboard.js
    └── motor_sim.js
```

---

## 파일 컨벤션

- **Kconfig 설정:** `prj.conf` (공통), `boards/nrf52840dk_nrf52840.conf` (보드별)
- **Devicetree 오버레이:** `app.overlay` 또는 `boards/nrf52840dk_nrf52840.overlay` — 임의 파일명 금지
- **`.conf` 수정 후 반드시** `build/zephyr/.config`와 대조 검증

---

## 핵심 Kconfig 심볼 (prj.conf 기준)

```
CONFIG_BT=y
CONFIG_BT_MESH=y
CONFIG_BT_MESH_RELAY=y          # Node B만
CONFIG_BT_MESH_GATT_PROXY=y     # Node C만
CONFIG_CMSIS_DSP=y
CONFIG_FPU=y
CONFIG_FPU_SHARING=y
CONFIG_I2C=y
CONFIG_SENSOR=y
CONFIG_MPU6050=y                 # 또는 CONFIG_MPU6050_TRIGGER_OWN_THREAD=y
CONFIG_FLASH=y
CONFIG_FLASH_MAP=y
CONFIG_NVS=y                     # 기준선 Flash 저장용
CONFIG_CBPRINTF_FP_SUPPORT=y
```

- `.conf` 수정 시 반드시 **kconfig-ref 스킬** 실행 또는 validate-kconfig 훅 확인
- 심볼 존재 여부는 `build/zephyr/.config` 또는 `grep -r "config <SYMBOL>" zephyr/` 로 확인

---

## BLE 구성

- **프로파일:** Bluetooth Mesh 1.0.1 + Custom Vendor Model
- **GATT Characteristics (Node C):**
  - `Spectrum Aggregation` — Notify (UUID 정의: `firmware/node_c/src/gatt_service.h`)
  - `Baseline Reset` — Write
  - `Threshold Control` — Write
  - `Scenario Inject` — Write
- **Mesh PDU 제한:** ≤ 384 bytes → 이상 지표 수치 + top8 빈만 전송 (<40 bytes)

---

## Python 브릿지

- **파일:** `bridge/gateway_bridge.py`
- **실행:** `python gateway_bridge.py` (venv 활성화 필요)
- **의존성:** `bleak==0.21`, `websockets` (`pip install -r requirements.txt`)
- **WebSocket 포트:** `8765` (localhost)
- **BLE 게이트웨이 주소:** `bridge/gateway_addr.txt` 참조 (gitignore됨)

---

## 웹 대시보드

- **Three.js:** r165 (CDN) — `motor_sim.js`
- **D3.js:** v7 (CDN) — `dashboard.js`
- **WebSocket 연결:** `ws://localhost:8765`
- 상세 작업 시 **web-dashboard 스킬** 참조

---

## 스킬 참조 가이드

| 작업                                | 스킬                       |
| ----------------------------------- | -------------------------- |
| `prj.conf` 수정 / Kconfig 심볼 추가 | `skills/kconfig-ref.md`    |
| FFT 파이프라인 / 이상 감지 코드     | `skills/fft-pipeline.md`   |
| BLE Mesh / GATT 디버깅              | `skills/ble-mesh-debug.md` |
| Three.js 모터 시뮬 / D3.js 패널     | `skills/web-dashboard.md`  |

---

## 제한 사항 (AI에게)

- **레지스터 직접 기술 금지:** SoC 레지스터 비트값은 `nrf52840.svd` 참조
- **존재하지 않는 Kconfig 심볼 생성 금지:** 항상 `build/zephyr/.config` 또는 `grep`으로 확인
- **Devicetree 오버레이 파일명 임의 지정 금지:** 컨벤션 섹션 참조
- **바이너리 패킹 / 비트 시프트 코드:** 반드시 nRF52840 엔디안(LE) 명시
- **`west build` 후 검증:** 코드 수정 후 항상 빌드를 돌려 결과 확인
