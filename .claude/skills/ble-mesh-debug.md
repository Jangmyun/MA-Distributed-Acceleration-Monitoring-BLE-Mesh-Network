# Skill: BLE Mesh + GATT 디버깅

## 언제 이 스킬을 사용하나

- BLE Mesh Provisioning 또는 Vendor Model 송수신이 안 될 때
- Node C GATT Notify가 Python 브릿지에 도달하지 않을 때
- Mesh PDU 사이즈 오류 또는 패킷 드롭 발생 시
- 노드 offline 판정 타이밍이 맞지 않을 때
- 시나리오 주입(GATT Write)이 펌웨어에 전달되지 않을 때

---

## 아키텍처 리마인더

```
Node A ──BLE Mesh── Node B (Relay) ──BLE Mesh── Node C (GW)
  FFT publish         FFT publish + relay           GATT Notify
                                                       ↓
                                               gateway_bridge.py
                                               (bleak GATT Client)
                                                       ↓
                                               WebSocket :8765
```

---

## Kconfig 전제 조건

### Node A / B (Sensor)
```
CONFIG_BT=y
CONFIG_BT_MESH=y
CONFIG_BT_MESH_RELAY=y          # Node B만
CONFIG_BT_MESH_ADV_BUF_COUNT=6  # 기본값 확인
```

### Node C (Gateway)
```
CONFIG_BT=y
CONFIG_BT_MESH=y
CONFIG_BT_MESH_GATT_PROXY=y
CONFIG_BT_GATT=y
CONFIG_BT_PERIPHERAL=y
CONFIG_BT_MAX_CONN=1            # 브릿지 1개 연결
```

확인: `grep "CONFIG_BT" build/zephyr/.config`

---

## Mesh Vendor Model — 페이로드 구조

```c
/* Mesh PDU 한계: ≤ 384 bytes (실제 Vendor Model access: ≤ 11 bytes unseg, ≤ 384 seg) */
/* 이 프로젝트는 <40 bytes 목표 */

typedef struct __attribute__((packed)) {
    char     node_id;       // 'A', 'B', 'C'
    uint8_t  severity;      // 0=normal, 1=warning, 2=critical
    float    dom_freq;      // Hz (4 bytes, LE)
    float    sfm;           // (4 bytes)
    float    rms_dev;       // (4 bytes)
    uint16_t top8[8];       // 8빈 진폭 (16 bytes)
    uint32_t ts;            // Unix timestamp (4 bytes)
} mesh_payload_t;           // 총 35 bytes
```

> nRF52840은 Little-Endian. Python 브릿지에서 `struct.unpack('<cfff8HI', data)` 사용.

---

## GATT Service 정의 (Node C)

```c
/* gatt_service.h에서 UUID 정의 */
#define VIBMON_SVC_UUID     BT_UUID_128_ENCODE(0x12345678, ...)
#define SPEC_AGGR_CHAR_UUID BT_UUID_128_ENCODE(0x12345679, ...)  // Notify
#define BASELINE_CHAR_UUID  BT_UUID_128_ENCODE(0x1234567A, ...)  // Write
#define THRESHOLD_CHAR_UUID BT_UUID_128_ENCODE(0x1234567B, ...)  // Write
#define SCENARIO_CHAR_UUID  BT_UUID_128_ENCODE(0x1234567C, ...)  // Write

/* Notify 호출 패턴 */
bt_gatt_notify(NULL, &attrs[SPEC_AGGR_IDX], &payload, sizeof(payload));
```

---

## 디버깅 단계

### 1단계 — Mesh Provisioning 확인

```bash
# J-Link RTT 또는 UART 로그에서 확인
# Zephyr LOG 레벨 설정
CONFIG_BT_MESH_LOG_LEVEL_DBG=y   # 디버그 시에만 사용, Flash 용량 주의
```

정상 프로비저닝 로그:
```
[00:00:01.234] <inf> bt_mesh_prov: Provisioning started
[00:00:03.456] <inf> bt_mesh_prov: Node provisioned, unicast addr 0x0001
```

### 2단계 — Vendor Model publish 확인

```c
/* publish 반환값 확인 */
int err = bt_mesh_model_publish(vendor_model);
if (err) {
    LOG_ERR("Mesh publish failed: %d", err);
    /* -EADDRNOTAVAIL: 아직 프로비저닝 안 됨
     * -ENOBUFS: ADV 버퍼 부족 → CONFIG_BT_MESH_ADV_BUF_COUNT 증가
     * -EMSGSIZE: PDU 너무 큼 → payload 줄이기 */
}
```

### 3단계 — GATT Notify 도달 확인 (Python 측)

```python
# gateway_bridge.py에서 수신 로그 추가
async def on_notify(_, data: bytearray):
    print(f"[GATT Notify] {len(data)} bytes: {data.hex()}")
    # 데이터 파싱
    import struct
    node_id, severity, dom_freq, sfm, rms_dev = struct.unpack_from('<cfff', data)
    print(f"  node={node_id} severity={severity} dom_freq={dom_freq:.1f}Hz")
```

### 4단계 — 노드 offline 판정 (Node C 펌웨어)

```c
/* 15초 수신 없으면 offline */
#define NODE_TIMEOUT_MS 15000

/* 각 노드별 마지막 수신 타임스탬프 */
static int64_t last_rx_ms[3];  // A=0, B=1, C=2

/* 1초 타이머에서 확인 */
void check_node_timeout(void)
{
    int64_t now = k_uptime_get();
    for (int i = 0; i < 3; i++) {
        if ((now - last_rx_ms[i]) > NODE_TIMEOUT_MS) {
            node_state[i].online = false;
        }
    }
}
```

---

## 자주 발생하는 문제

| 증상 | 원인 | 해결 |
|------|------|------|
| Provisioning 완료 안 됨 | `CONFIG_BT_MESH_PROV=y` 누락 | Kconfig 확인 |
| Node B relay 안 됨 | `CONFIG_BT_MESH_RELAY=y` 누락 | Node B prj.conf 확인 |
| GATT Notify 미수신 | CCCD 활성화 안 됨 | bleak에서 `start_notify` 호출 확인 |
| PDU 드롭 | ADV 버퍼 부족 | `CONFIG_BT_MESH_ADV_BUF_COUNT` 8 이상으로 증가 |
| 시나리오 주입 무시 | GATT Write 권한 오류 | Characteristic 권한 `BT_GATT_PERM_WRITE` 확인 |
| RSSI가 항상 0 | Node C에서 측정 안 함 | `bt_conn_get_info()` 또는 Mesh `bt_mesh_rx_rssi` 활용 |

---

## 시나리오 주입 흐름 검증

```
브라우저 버튼 클릭
  → WebSocket send: {"type":"inject_scenario","scenario":"bearing_wear"}
  → gateway_bridge.py ws_handler 수신
  → gatt_write(SCENARIO_CHAR_UUID, b"bearing_wear")
  → Node C on_scenario_write() 콜백 호출
  → BLE Mesh publish: 베어링 마모 진동 패턴 데이터
  → Node A/B FFT 파이프라인 통과
  → severity 판정 → GATT Notify
```

각 화살표를 로그로 확인하며 어디서 끊기는지 추적.

---

## RTT 로그 보기 (J-Link)

```bash
# JLinkRTTViewer 또는 터미널에서
JLinkExe -device NRF52840_XXAA -if SWD -speed 4000 -autoconnect 1
# 연결 후:
connect
r
go

# 별도 터미널
JLinkRTTClient
```

또는 Zephyr `west` 통합:
```bash
west attach --runner jlink  # RTT 스트림 연결
```
