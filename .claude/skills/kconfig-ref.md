# Skill: Kconfig 심볼 참조 및 검증

## 언제 이 스킬을 사용하나

- `prj.conf` 또는 `boards/*.conf` 파일을 추가/수정할 때
- 새 `CONFIG_*` 심볼을 활성화하려 할 때
- 빌드 후 `.config`에 심볼이 사라졌을 때 (silent failure 추적)
- `west build` 실패 후 Kconfig 의존성 오류를 해석할 때

---

## Step 1 — 빌드된 .config에서 현재 상태 확인

```bash
# 심볼 존재 여부 확인
grep "CONFIG_<SYMBOL>" build/zephyr/.config

# 관련 심볼 묶음 확인 (예: BT 관련 전체)
grep "CONFIG_BT" build/zephyr/.config | head -40

# prj.conf에 있는데 .config에 없는 심볼 찾기 (silent failure 탐지)
comm -23 \
  <(grep "^CONFIG_" prj.conf | sort) \
  <(grep "^CONFIG_" build/zephyr/.config | sort)
```

> 빌드가 안 된 상태라면 Step 2로 먼저 소스를 확인한다.

---

## Step 2 — Kconfig 소스에서 심볼 정의 확인

```bash
# 심볼 정의 찾기 (depends on, select, default 포함)
grep -rn "config <SYMBOL>" zephyr/ modules/ --include="Kconfig*"

# 예: CMSIS_DSP 의존성 전체 확인
grep -rn "config CMSIS_DSP" zephyr/ modules/ --include="Kconfig*" -A 10

# BT_MESH_RELAY 의존성 확인
grep -rn "config BT_MESH_RELAY" zephyr/ --include="Kconfig*" -A 8
```

출력에서 반드시 확인할 항목:
- `depends on` — 이 심볼이 켜지려면 무엇이 먼저 켜져야 하는가
- `select` — 이 심볼이 켜지면 자동으로 켜지는 것
- `default` — 기본값 (y/n/숫자)

---

## Step 3 — .conf 수정 후 검증

```bash
# 수정 후 재빌드
west build -b nrf52840dk/nrf52840

# 의도한 심볼이 실제로 켜졌는지 확인
grep "CONFIG_<SYMBOL>" build/zephyr/.config
```

심볼이 `# CONFIG_<SYMBOL> is not set` 상태면 → `depends on` 체인에서 누락된 것을 찾는다.

---

## 이 프로젝트의 주요 심볼 의존성 체인

### CMSIS-DSP (FFT 파이프라인 핵심)
```
CONFIG_CMSIS_DSP=y
  → requires: CONFIG_FPU=y (Cortex-M4F HW FPU)
  → requires: CONFIG_FPU_SHARING=y (RTOS 멀티스레드 FPU 공유)
```

### BLE Mesh
```
CONFIG_BT_MESH=y
  → requires: CONFIG_BT=y
  → select: CONFIG_NET_BUF
  → select: CONFIG_TINYCRYPT (기본 암호화)

CONFIG_BT_MESH_RELAY=y   # Node B만
  → requires: CONFIG_BT_MESH=y

CONFIG_BT_MESH_GATT_PROXY=y  # Node C만
  → requires: CONFIG_BT_MESH=y
  → requires: CONFIG_BT_GATT_PROXY=y (자동 select될 수 있음, 확인 필요)
```

### NVS (기준선 Flash 저장)
```
CONFIG_NVS=y
  → requires: CONFIG_FLASH=y
  → requires: CONFIG_FLASH_MAP=y
  → requires: CONFIG_FLASH_PAGE_LAYOUT=y (nRF52840 드라이버에서 자동)
```

### MPU-6050 센서
```
CONFIG_MPU6050=y
  → requires: CONFIG_SENSOR=y
  → requires: CONFIG_I2C=y
```

---

## Silent Failure 패턴 — 자주 빠지는 함정

| 증상 | 원인 | 해결 |
|------|------|------|
| `CONFIG_CMSIS_DSP` 빌드에서 사라짐 | `CONFIG_FPU=y` 누락 | `prj.conf`에 추가 |
| `CONFIG_BT_MESH_GATT_PROXY` 무시됨 | `CONFIG_BT_MESH=y` 순서 또는 의존성 | Kconfig 소스 `depends on` 확인 |
| NVS 파티션 없음 | `CONFIG_FLASH_MAP=y` 누락 또는 pm_static.yml 미설정 | flash map 설정 확인 |
| MPU-6050 드라이버 미로드 | DTS에서 `status = "okay"` 누락 | `app.overlay` 확인 |

---

## 노드별 prj.conf 분리 전략

Node A/B (Sensor)와 Node C (Gateway)는 Kconfig가 다르다.

```
firmware/
├── node_a/
│   ├── prj.conf           # CONFIG_BT_MESH_RELAY 없음
│   └── app.overlay
├── node_b/
│   ├── prj.conf           # CONFIG_BT_MESH_RELAY=y 추가
│   └── app.overlay
└── node_c/
    ├── prj.conf           # CONFIG_BT_MESH_GATT_PROXY=y, CONFIG_BT_GATT=y
    └── app.overlay
```

공통 심볼은 각 `prj.conf`에 중복 작성하거나, CMakeLists.txt에서 `list(APPEND OVERLAY_CONFIG "../common.conf")`로 공유.
