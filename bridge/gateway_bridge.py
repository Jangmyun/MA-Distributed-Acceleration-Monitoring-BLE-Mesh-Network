"""
gateway_bridge.py  —  Node C (nRF52840 Gateway) → WebSocket Bridge
====================================================================

입력 소스 (택 1, 상호 배타적):
  --serial PORT [--baud N]   Node C UART 출력 파싱  ← 권장 (안정적)
  --addr   MAC               Node C BLE GATT Notify 구독
  --mock                     더미 가속도 데이터 생성 (하드웨어 없이 테스트)

────────────────────────────────────────────────────────────────────
Node C 펌웨어에서 UART로 출력해야 하는 형식 (둘 중 하나):

  형식 1 — JSON 한 줄 (권장, PRD §4.2):
    {"nodes":[{"id":"A","x":123,"y":-234,"z":981,"rssi":-45},
              {"id":"B","x":50,"y":100,"z":960,"rssi":-62},
              {"id":"C","x":10,"y":-20,"z":975,"rssi":0}],
     "links":[{"src":"A","dst":"B","rssi":-52},
              {"src":"B","dst":"C","rssi":-48}]}

  형식 2 — 단순 라인 (빠른 테스트, rssi/links 없음):
    ACCEL:A:123,-234,981
    ACCEL:B:50,100,960
    ACCEL:C:10,-20,975

────────────────────────────────────────────────────────────────────
WebSocket 출력 페이로드 (→ 웹 대시보드, PRD §4.3):

  {
    "nodes": [
      {"id":"A","x":123,"y":-234,"z":981,
       "roll":13.5,"pitch":-0.7,"online":true,"rssi":-45},
      ...
    ],
    "links": [{"src":"A","dst":"B","rssi":-52}, ...],
    "ts": 1735200000
  }

────────────────────────────────────────────────────────────────────
사용 예:
  python gateway_bridge.py --serial /dev/cu.usbmodemXXXX
  python gateway_bridge.py --serial COM3 --baud 115200
  python gateway_bridge.py --addr AA:BB:CC:DD:EE:FF
  python gateway_bridge.py --mock
  python gateway_bridge.py --mock --debug
"""

import argparse
import asyncio
import json
import logging
import math
import random
import time
from collections import deque
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

import websockets
from websockets.server import WebSocketServerProtocol

# ── 로거 ──────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("bridge")

# ── GATT UUID (Node C GATT Server 구현 시 firmware와 반드시 일치) ──────────────
# firmware/node_c/src/gatt_service.h 의 UUID와 동일해야 함
AGGR_SVC_UUID    = "bfbc1234-bc67-4b04-a2c7-11c9c7bdeb82"
AGGR_NOTIFY_UUID = "bfbc1235-bc67-4b04-a2c7-11c9c7bdeb82"  # Notify

# ── 설정 ──────────────────────────────────────────────────────────────────────
WS_HOST             = "0.0.0.0"
WS_PORT             = 8765
BLE_CONNECT_TIMEOUT = 15.0   # 초
BLE_RECONNECT_DELAY = 3.0    # 초
SERIAL_BAUD_DEFAULT = 115200
OFFLINE_TIMEOUT_S   = 15.0   # 이 시간 동안 미수신 → online: false (PRD §5.1)
SMOOTH_N            = 3      # 이동 평균 윈도우 (PRD §8 노이즈 대응)
MOCK_INTERVAL       = 0.5    # 초 (mock 브로드캐스트 주기)
GATEWAY_ADDR_FILE   = Path(__file__).parent / "gateway_addr.txt"


# ═════════════════════════════════════════════════════════════════════════════
# Roll / Pitch 계산 (PRD §3)
# ═════════════════════════════════════════════════════════════════════════════

def calc_angles(x_centi: int, y_centi: int, z_centi: int) -> Tuple[float, float]:
    """centiunits(val×100) 가속도에서 Roll/Pitch 각도(도)를 계산한다.

    roll  = atan2(y, z)          × (180 / π)
    pitch = atan2(-x, √(y²+z²)) × (180 / π)

    centiunits: 예) 981 → 9.81 m/s²
    """
    x = x_centi / 100.0
    y = y_centi / 100.0
    z = z_centi / 100.0
    roll  = math.degrees(math.atan2(y, z))
    pitch = math.degrees(math.atan2(-x, math.sqrt(y * y + z * z)))
    return round(roll, 1), round(pitch, 1)


# ═════════════════════════════════════════════════════════════════════════════
# 이동 평균 필터 (PRD §8 노이즈 대응)
# ═════════════════════════════════════════════════════════════════════════════

class MovingAverage:
    """3축 이동 평균 필터."""

    def __init__(self, n: int = SMOOTH_N) -> None:
        self._bufs: Dict[str, deque] = {
            ax: deque(maxlen=n) for ax in ("x", "y", "z")
        }

    def update(self, x: int, y: int, z: int) -> Tuple[int, int, int]:
        self._bufs["x"].append(x)
        self._bufs["y"].append(y)
        self._bufs["z"].append(z)
        return (
            int(sum(self._bufs["x"]) / len(self._bufs["x"])),
            int(sum(self._bufs["y"]) / len(self._bufs["y"])),
            int(sum(self._bufs["z"]) / len(self._bufs["z"])),
        )


# ═════════════════════════════════════════════════════════════════════════════
# 노드 상태 추적기
# ═════════════════════════════════════════════════════════════════════════════

class NodeTracker:
    """노드별 최신 가속도·각도·online 상태를 관리한다."""

    def __init__(self) -> None:
        self._data:      Dict[str, dict]         = {}
        self._last_seen: Dict[str, float]        = {}
        self._filters:   Dict[str, MovingAverage] = {}

    def update(self, node_id: str, x: int, y: int, z: int, rssi: int = 0) -> None:
        """노드 데이터를 갱신한다. 스무딩 후 roll/pitch를 계산해 저장한다."""
        if node_id not in self._filters:
            self._filters[node_id] = MovingAverage()

        sx, sy, sz     = self._filters[node_id].update(x, y, z)
        roll, pitch    = calc_angles(sx, sy, sz)

        self._data[node_id] = {
            "id":     node_id,
            "x":      sx,
            "y":      sy,
            "z":      sz,
            "roll":   roll,
            "pitch":  pitch,
            "rssi":   rssi,
            "online": True,
        }
        self._last_seen[node_id] = time.time()
        log.debug("Node %s  x=%d y=%d z=%d  roll=%.1f pitch=%.1f",
                  node_id, sx, sy, sz, roll, pitch)

    def build_state(self, links: List[dict]) -> dict:
        """현재 노드 상태 + 링크를 WebSocket 페이로드로 조립한다.

        OFFLINE_TIMEOUT_S 초 이상 미수신 노드는 online: false 처리 (PRD §5.1).
        """
        now   = time.time()
        nodes = []
        for nid in sorted(self._data):
            node = dict(self._data[nid])
            if now - self._last_seen.get(nid, 0) > OFFLINE_TIMEOUT_S:
                node["online"] = False
            nodes.append(node)
        return {"nodes": nodes, "links": links, "ts": int(now)}

    def synthetic_links(self) -> List[dict]:
        """UART 모드에서 RSSI 없이 고정 토폴로지 링크를 생성한다.

        온라인 노드만 포함: A→B→C 릴레이 체인 기준.
        """
        now    = time.time()
        online = {nid for nid, t in self._last_seen.items()
                  if now - t <= OFFLINE_TIMEOUT_S}
        links: List[dict] = []
        if "A" in online and "B" in online:
            links.append({"src": "A", "dst": "B", "rssi": -55})
        if "B" in online and "C" in online:
            links.append({"src": "B", "dst": "C", "rssi": -50})
        elif "A" in online and "C" in online:
            # B가 오프라인 → A-C 직접 링크
            links.append({"src": "A", "dst": "C", "rssi": -65})
        return links


_tracker = NodeTracker()


# ═════════════════════════════════════════════════════════════════════════════
# WebSocket 서버
# ═════════════════════════════════════════════════════════════════════════════

class BridgeState:
    def __init__(self) -> None:
        self.ws_clients:  Set[WebSocketServerProtocol] = set()
        self.last_payload: Optional[dict]              = None
        self.ble_client                                = None


_state = BridgeState()


async def ws_broadcast(payload: dict) -> None:
    """연결된 모든 WebSocket 클라이언트에 JSON 페이로드를 전송한다."""
    _state.last_payload = payload
    if not _state.ws_clients:
        return
    msg = json.dumps(payload, ensure_ascii=False)
    results = await asyncio.gather(
        *[ws.send(msg) for ws in _state.ws_clients],
        return_exceptions=True,
    )
    for r in results:
        if isinstance(r, Exception):
            log.debug("WS 전송 오류 (클라이언트 끊김): %s", r)
    log.debug("Broadcast → %d clients", len(_state.ws_clients))


async def ws_handler(ws: WebSocketServerProtocol) -> None:
    """WebSocket 클라이언트 연결 수명을 처리한다.

    신규 연결 시 마지막 상태를 즉시 전송하여 대시보드 초기 렌더링을 보장한다.
    """
    _state.ws_clients.add(ws)
    log.info("WS 연결: %s  (총 %d개)", ws.remote_address, len(_state.ws_clients))

    if _state.last_payload:
        try:
            await ws.send(json.dumps(_state.last_payload))
        except Exception:
            pass

    try:
        async for _ in ws:
            pass  # 브라우저 → 브릿지 명령은 현재 미사용
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        _state.ws_clients.discard(ws)
        log.info("WS 끊김: %s  (총 %d개)", ws.remote_address, len(_state.ws_clients))


# ═════════════════════════════════════════════════════════════════════════════
# 페이로드 처리 (공통)
# ═════════════════════════════════════════════════════════════════════════════

def _process_node_c_json(raw: dict) -> Optional[dict]:
    """Node C에서 수신한 JSON 객체를 roll/pitch 포함 WebSocket 페이로드로 변환한다.

    입력 (PRD §4.2):
      {"nodes":[{"id":"A","x":123,"y":-234,"z":981,"online":true,"rssi":-45},...],
       "links":[{"src":"A","dst":"B","rssi":-52},...]}

    출력 (PRD §4.3): roll/pitch 추가 + ts 보장
    """
    try:
        nodes_in = raw.get("nodes", [])
        links    = raw.get("links", [])

        for n in nodes_in:
            nid    = str(n.get("id", "?")).upper()
            x      = int(n.get("x", 0))
            y      = int(n.get("y", 0))
            z      = int(n.get("z", 0))
            rssi   = int(n.get("rssi", 0))
            online = bool(n.get("online", True))

            if online:
                _tracker.update(nid, x, y, z, rssi)
            # online=false 인 노드는 OFFLINE_TIMEOUT_S가 자동 처리

        return _tracker.build_state(links)
    except Exception as e:
        log.warning("JSON 처리 오류: %s | raw=%s", e, str(raw)[:80])
        return None


def _process_accel_line(line: str) -> Optional[dict]:
    """'ACCEL:<id>:<x>,<y>,<z>' 단순 라인 형식을 파싱한다.

    예) "ACCEL:A:123,-234,981"

    Node C 펌웨어에서 handle_chat_message() 안에 아래를 추가하면 동작:
      printk("ACCEL:%c:%d,%d,%d\\n", node_id, x_centi, y_centi, z_centi);
    """
    try:
        # "ACCEL:A:123,-234,981" → prefix="ACCEL", id="A", vals="123,-234,981"
        prefix, nid, vals = line.strip().split(":", 2)
        if prefix.upper() != "ACCEL":
            return None
        x, y, z = (int(v) for v in vals.split(","))
        _tracker.update(nid.strip().upper(), x, y, z)
        return _tracker.build_state(_tracker.synthetic_links())
    except (ValueError, AttributeError):
        return None


# ═════════════════════════════════════════════════════════════════════════════
# UART / Serial 루프  (권장 경로)
# ═════════════════════════════════════════════════════════════════════════════

async def serial_run(port: str, baud: int) -> None:
    """Node C UART 출력을 읽어 WebSocket으로 브로드캐스트한다.

    Node C 펌웨어에서 UART로 출력해야 하는 형식:
      형식 1 (JSON 줄): {"nodes":[...],"links":[...]}
      형식 2 (단순 줄): ACCEL:A:123,-234,981

    연결 끊김 시 3초 후 자동 재시도한다.
    """
    import serial  # type: ignore  (pyserial)

    loop = asyncio.get_running_loop()

    def _reader() -> None:
        log.info("시리얼 포트 열기: %s @ %d baud", port, baud)
        while True:
            try:
                with serial.Serial(port, baud, timeout=1.0) as ser:
                    log.info("시리얼 연결 완료: %s", port)
                    while True:
                        raw = ser.readline()
                        if not raw:
                            continue

                        try:
                            line = raw.decode("utf-8", errors="replace").strip()
                        except Exception:
                            continue
                        if not line:
                            continue

                        log.debug("UART ← %s", line)

                        payload: Optional[dict] = None

                        if line.startswith("{"):
                            # 형식 1: JSON 줄
                            try:
                                obj     = json.loads(line)
                                payload = _process_node_c_json(obj)
                            except json.JSONDecodeError:
                                log.debug("JSON 파싱 실패: %s", line[:60])

                        elif line.upper().startswith("ACCEL:"):
                            # 형식 2: ACCEL:<id>:<x>,<y>,<z>
                            payload = _process_accel_line(line)

                        if payload:
                            asyncio.run_coroutine_threadsafe(
                                ws_broadcast(payload), loop
                            )

            except serial.SerialException as e:
                log.error("시리얼 오류: %s — 3초 후 재시도", e)
                time.sleep(3.0)
            except Exception as e:
                log.error("예기치 않은 시리얼 오류: %s", e)
                time.sleep(3.0)

    # 블로킹 I/O를 스레드 풀에서 실행
    await loop.run_in_executor(None, _reader)


# ═════════════════════════════════════════════════════════════════════════════
# BLE GATT 루프  (Node C GATT Server 구현 후 사용)
# ═════════════════════════════════════════════════════════════════════════════

async def ble_run(gateway_addr: str) -> None:
    """Node C BLE GATT Aggregation Notify를 구독하여 WebSocket으로 브로드캐스트한다.

    Node C GATT Server 구현 필요 (현재 PRD 기준 ❌):
      Service UUID : bfbc1234-bc67-4b04-a2c7-11c9c7bdeb82
      Notify  UUID : bfbc1235-bc67-4b04-a2c7-11c9c7bdeb82
      페이로드     : PRD §4.2 JSON (UTF-8)

    연결 끊김 시 BLE_RECONNECT_DELAY 초 후 자동 재시도한다.
    """
    try:
        from bleak import BleakClient                               # type: ignore
        from bleak.backends.characteristic import BleakGATTCharacteristic  # type: ignore
    except ImportError:
        log.error("bleak 패키지 없음: pip install bleak")
        return

    loop = asyncio.get_running_loop()

    def _on_notify(_char: "BleakGATTCharacteristic", data: bytearray) -> None:
        try:
            raw     = json.loads(data.decode("utf-8"))
            payload = _process_node_c_json(raw)
            if payload:
                asyncio.run_coroutine_threadsafe(ws_broadcast(payload), loop)
        except Exception as e:
            log.warning("GATT Notify 파싱 실패: %s | raw=%s", e, bytes(data[:64]))

    while True:
        log.info("BLE 연결 시도: %s", gateway_addr)
        try:
            async with BleakClient(gateway_addr, timeout=BLE_CONNECT_TIMEOUT) as client:
                _state.ble_client = client
                log.info("BLE 연결 완료: %s", gateway_addr)
                await client.start_notify(AGGR_NOTIFY_UUID, _on_notify)
                log.info("Aggregation Notify 구독 완료")
                while client.is_connected:
                    await asyncio.sleep(1.0)
                log.warning("BLE 연결 끊김: %s", gateway_addr)
        except Exception as e:
            log.error("BLE 오류 [%s]: %s", type(e).__name__, e)
        finally:
            _state.ble_client = None
        log.info("%.0f초 후 BLE 재연결…", BLE_RECONNECT_DELAY)
        await asyncio.sleep(BLE_RECONNECT_DELAY)


# ═════════════════════════════════════════════════════════════════════════════
# Mock 루프  (하드웨어 없이 테스트)
# ═════════════════════════════════════════════════════════════════════════════

def _accel_from_rp(roll_deg: float, pitch_deg: float, g: int = 981) -> Tuple[int, int, int]:
    """Roll/Pitch 각도에서 ADXL345 centiunits 가속도를 역산한다."""
    r = math.radians(roll_deg)
    p = math.radians(pitch_deg)
    x = int(-math.sin(p) * g)
    y = int(math.sin(r) * math.cos(p) * g)
    z = int(math.cos(r) * math.cos(p) * g)
    return x, y, z


def _mock_payload(elapsed: float) -> dict:
    """데모용 sinusoidal 가속도 더미 데이터를 생성한다.

    Node A: roll ±30°  (0.20 Hz)   — 좌우 기울기
    Node B: pitch ±20° (0.15 Hz)   — 앞뒤 기울기
    Node C: 수평 고정 (gateway)
    """
    # Node A
    roll_a = 30.0 * math.sin(2 * math.pi * 0.20 * elapsed)
    ax, ay, az = _accel_from_rp(roll_a, 0.0)

    # Node B
    pitch_b = 20.0 * math.sin(2 * math.pi * 0.15 * elapsed + 1.0)
    bx, by, bz = _accel_from_rp(0.0, pitch_b)

    # Node C  (미세 노이즈만)
    cx = int(random.gauss(0, 5))
    cy = int(random.gauss(0, 5))
    cz = int(981 + random.gauss(0, 5))

    for nid, x, y, z, rssi in [
        ("A", ax, ay, az, -45),
        ("B", bx, by, bz, -62),
        ("C", cx, cy, cz,   0),
    ]:
        _tracker.update(nid, x, y, z, rssi)

    links = [
        {"src": "A", "dst": "B", "rssi": int(-52 + random.gauss(0, 2))},
        {"src": "B", "dst": "C", "rssi": int(-48 + random.gauss(0, 2))},
    ]
    return _tracker.build_state(links)


async def mock_run() -> None:
    log.info("[MOCK] 모드 활성 — %.1f초 주기 브로드캐스트", MOCK_INTERVAL)
    t0 = time.time()
    while True:
        payload = _mock_payload(time.time() - t0)
        await ws_broadcast(payload)
        await asyncio.sleep(MOCK_INTERVAL)


# ═════════════════════════════════════════════════════════════════════════════
# 게이트웨이 주소 해석
# ═════════════════════════════════════════════════════════════════════════════

def resolve_gateway_addr(cli_addr: Optional[str]) -> Optional[str]:
    if cli_addr:
        return cli_addr
    if GATEWAY_ADDR_FILE.exists():
        addr = GATEWAY_ADDR_FILE.read_text().strip()
        if addr:
            log.info("게이트웨이 주소 (gateway_addr.txt): %s", addr)
            return addr
    log.error(
        "게이트웨이 주소 없음. "
        "--addr <MAC> 또는 bridge/gateway_addr.txt에 BLE 주소를 작성하세요."
    )
    return None


# ═════════════════════════════════════════════════════════════════════════════
# 엔트리포인트
# ═════════════════════════════════════════════════════════════════════════════

async def _amain(args: argparse.Namespace) -> None:
    server = await websockets.serve(ws_handler, WS_HOST, WS_PORT)
    log.info("WebSocket 서버 시작: ws://%s:%d", WS_HOST, WS_PORT)

    if args.mock:
        data_task = asyncio.create_task(mock_run(), name="mock")
    elif args.serial:
        data_task = asyncio.create_task(
            serial_run(args.serial, args.baud), name="serial"
        )
    else:
        addr = resolve_gateway_addr(args.addr)
        if not addr:
            server.close()
            return
        data_task = asyncio.create_task(ble_run(addr), name="ble")

    try:
        await asyncio.gather(server.wait_closed(), data_task)
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        data_task.cancel()
        server.close()
        await server.wait_closed()
        log.info("Bridge 종료.")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="BLE Mesh Gateway → WebSocket Bridge (PRD §5.3)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    src = parser.add_mutually_exclusive_group()
    src.add_argument(
        "--serial", metavar="PORT",
        help="Node C UART 포트 (예: /dev/cu.usbmodemXXXX, COM3). 권장.",
    )
    src.add_argument(
        "--addr", metavar="MAC",
        help="Node C BLE 주소 (예: AA:BB:CC:DD:EE:FF). gateway_addr.txt 대체.",
    )
    src.add_argument(
        "--mock", action="store_true",
        help="더미 sinusoidal 가속도 데이터 생성 (하드웨어 없이 테스트).",
    )

    parser.add_argument(
        "--baud", type=int, default=SERIAL_BAUD_DEFAULT,
        help=f"UART 보드레이트 (기본값: {SERIAL_BAUD_DEFAULT})",
    )
    parser.add_argument(
        "--debug", action="store_true",
        help="DEBUG 레벨 로그 출력.",
    )

    args = parser.parse_args()

    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)

    # --serial 인데 pyserial 없으면 조기 종료
    if args.serial:
        try:
            import serial  # noqa: F401
        except ImportError:
            log.error("pyserial 패키지 없음: pip install pyserial")
            return

    try:
        asyncio.run(_amain(args))
    except KeyboardInterrupt:
        log.info("사용자 중단.")


if __name__ == "__main__":
    main()
