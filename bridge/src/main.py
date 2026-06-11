"""
main.py — BLE Mesh Gateway Bridge 엔트리포인트

사용법:
  python src/main.py --serial /dev/cu.usbmodemXXXX
  python src/main.py --serial COM3 --baud 115200
  python src/main.py --mock
  python src/main.py --mock --debug
"""

import argparse
import asyncio
import json
import logging
import math
import random
import sys
import time
from collections import deque
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

import websockets
from websockets.server import WebSocketServerProtocol

# serial_reader는 같은 src/ 패키지 내
sys.path.insert(0, str(Path(__file__).parent))
from serial_reader import SerialReader, ParsedMessage

# ── 로거 ──────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("bridge")

# ── 설정 ──────────────────────────────────────────────────────────────────────
WS_HOST          = "0.0.0.0"
WS_PORT          = 8765
OFFLINE_TIMEOUT_S = 15.0
SMOOTH_N         = 3
MOCK_INTERVAL    = 0.5


# ═════════════════════════════════════════════════════════════════════════════
# 각도 계산 / 이동 평균
# ═════════════════════════════════════════════════════════════════════════════

def calc_angles(x_centi: int, y_centi: int, z_centi: int) -> Tuple[float, float]:
    x = x_centi / 100.0
    y = y_centi / 100.0
    z = z_centi / 100.0
    roll  = math.degrees(math.atan2(y, z))
    pitch = math.degrees(math.atan2(-x, math.sqrt(y * y + z * z)))
    return round(roll, 1), round(pitch, 1)


class MovingAverage:
    def __init__(self, n: int = SMOOTH_N) -> None:
        self._bufs: Dict[str, deque] = {ax: deque(maxlen=n) for ax in ("x", "y", "z")}

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
    def __init__(self) -> None:
        self._data:       Dict[str, dict]          = {}
        self._last_seen:  Dict[str, float]         = {}
        self._filters:    Dict[str, MovingAverage] = {}

    def update(self, node_id: str, x: int, y: int, z: int, rssi: int = 0) -> None:
        if node_id not in self._filters:
            self._filters[node_id] = MovingAverage()
        sx, sy, sz  = self._filters[node_id].update(x, y, z)
        roll, pitch = calc_angles(sx, sy, sz)
        self._data[node_id] = {
            "id": node_id, "x": sx, "y": sy, "z": sz,
            "roll": roll, "pitch": pitch, "rssi": rssi, "online": True,
        }
        self._last_seen[node_id] = time.time()

    def build_state(self, links: List[dict]) -> dict:
        now   = time.time()
        nodes = []
        for nid in sorted(self._data):
            node = dict(self._data[nid])
            if now - self._last_seen.get(nid, 0) > OFFLINE_TIMEOUT_S:
                node["online"] = False
            nodes.append(node)
        return {"nodes": nodes, "links": links, "ts": int(now)}

    def synthetic_links(self) -> List[dict]:
        now    = time.time()
        online = {nid for nid, t in self._last_seen.items()
                  if now - t <= OFFLINE_TIMEOUT_S}
        links: List[dict] = []
        if "A" in online and "B" in online:
            links.append({"src": "A", "dst": "B", "rssi": -55})
        if "B" in online and "C" in online:
            links.append({"src": "B", "dst": "C", "rssi": -50})
        elif "A" in online and "C" in online:
            links.append({"src": "A", "dst": "C", "rssi": -65})
        return links


_tracker = NodeTracker()


# ═════════════════════════════════════════════════════════════════════════════
# WebSocket 서버
# ═════════════════════════════════════════════════════════════════════════════

_ws_clients:    Set[WebSocketServerProtocol] = set()
_last_payload:  Optional[dict]               = None


async def ws_broadcast(payload: dict) -> None:
    global _last_payload
    _last_payload = payload
    if not _ws_clients:
        return
    msg = json.dumps(payload, ensure_ascii=False)
    results = await asyncio.gather(
        *[ws.send(msg) for ws in _ws_clients],
        return_exceptions=True,
    )
    for r in results:
        if isinstance(r, Exception):
            log.debug("WS 전송 오류: %s", r)


async def ws_handler(ws: WebSocketServerProtocol) -> None:
    _ws_clients.add(ws)
    log.info("WS 연결: %s  (총 %d개)", ws.remote_address, len(_ws_clients))
    if _last_payload:
        try:
            await ws.send(json.dumps(_last_payload))
        except Exception:
            pass
    try:
        async for _ in ws:
            pass
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        _ws_clients.discard(ws)
        log.info("WS 끊김: %s  (총 %d개)", ws.remote_address, len(_ws_clients))


# ═════════════════════════════════════════════════════════════════════════════
# 직렬 메시지 처리 (SerialReader 콜백)
# ═════════════════════════════════════════════════════════════════════════════

async def on_serial_message(msg: ParsedMessage) -> None:
    """SerialReader가 전달한 파싱된 메시지를 WebSocket 페이로드로 변환한다."""
    payload: Optional[dict] = None

    if msg["type"] == "accel":
        d = msg["data"]
        log.info("[SERIAL] ACCEL  id=%s  x=%d  y=%d  z=%d", d["id"], d["x"], d["y"], d["z"])
        _tracker.update(d["id"], d["x"], d["y"], d["z"])
        payload = _tracker.build_state(_tracker.synthetic_links())

    elif msg["type"] == "json":
        raw = msg["data"]
        try:
            for n in raw.get("nodes", []):
                nid    = str(n.get("id", "?")).upper()
                x      = int(n.get("x", 0))
                y      = int(n.get("y", 0))
                z      = int(n.get("z", 0))
                rssi   = int(n.get("rssi", 0))
                log.info("[SERIAL] JSON   id=%s  x=%d  y=%d  z=%d  rssi=%d", nid, x, y, z, rssi)
                if n.get("online", True):
                    _tracker.update(nid, x, y, z, rssi)
            payload = _tracker.build_state(raw.get("links", []))
        except Exception as e:
            log.warning("JSON 처리 오류: %s", e)

    if payload:
        await ws_broadcast(payload)


# ═════════════════════════════════════════════════════════════════════════════
# Mock 루프
# ═════════════════════════════════════════════════════════════════════════════

def _accel_from_rp(roll_deg: float, pitch_deg: float, g: int = 981) -> Tuple[int, int, int]:
    r = math.radians(roll_deg)
    p = math.radians(pitch_deg)
    return (
        int(-math.sin(p) * g),
        int(math.sin(r) * math.cos(p) * g),
        int(math.cos(r) * math.cos(p) * g),
    )


async def mock_run() -> None:
    log.info("[MOCK] 모드 활성 — %.1f초 주기", MOCK_INTERVAL)
    t0 = time.time()
    while True:
        elapsed = time.time() - t0
        ax, ay, az = _accel_from_rp(30.0 * math.sin(2 * math.pi * 0.20 * elapsed), 0.0)
        bx, by, bz = _accel_from_rp(0.0, 20.0 * math.sin(2 * math.pi * 0.15 * elapsed + 1.0))
        cx = int(random.gauss(0, 5))
        cy = int(random.gauss(0, 5))
        cz = int(981 + random.gauss(0, 5))
        for nid, x, y, z, rssi in [("A", ax, ay, az, -45), ("B", bx, by, bz, -62), ("C", cx, cy, cz, 0)]:
            _tracker.update(nid, x, y, z, rssi)
        links = [
            {"src": "A", "dst": "B", "rssi": int(-52 + random.gauss(0, 2))},
            {"src": "B", "dst": "C", "rssi": int(-48 + random.gauss(0, 2))},
        ]
        await ws_broadcast(_tracker.build_state(links))
        await asyncio.sleep(MOCK_INTERVAL)


# ═════════════════════════════════════════════════════════════════════════════
# 엔트리포인트
# ═════════════════════════════════════════════════════════════════════════════

async def _amain(args: argparse.Namespace) -> None:
    server = await websockets.serve(ws_handler, WS_HOST, WS_PORT)
    log.info("WebSocket 서버 시작: ws://%s:%d", WS_HOST, WS_PORT)

    if args.mock:
        data_task = asyncio.create_task(mock_run(), name="mock")
    else:
        reader = SerialReader(port=args.serial, baud=args.baud, on_message=on_serial_message)
        data_task = asyncio.create_task(reader.run(), name="serial")

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
        description="BLE Mesh Gateway → WebSocket Bridge",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--serial", metavar="PORT", help="Node C UART 포트 (예: /dev/cu.usbmodemXXXX)")
    src.add_argument("--mock",   action="store_true", help="더미 데이터 생성 (하드웨어 없이 테스트)")
    parser.add_argument("--baud",  type=int, default=115200, help="UART 보드레이트 (기본값: 115200)")
    parser.add_argument("--debug", action="store_true", help="DEBUG 레벨 로그 출력")
    args = parser.parse_args()

    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)

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
