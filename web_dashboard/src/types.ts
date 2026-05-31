/* ─────────────────────────────────────────────
   공유 타입 정의 (PRD §5.1 / §5.4 페이로드 기준)
───────────────────────────────────────────── */

export type Severity = 'normal' | 'warning' | 'critical';

/** BLE Mesh 노드 한 개의 상태 (WebSocket 페이로드 내 nodes[]) */
export interface NodeState {
  id: string;           // 'A' | 'B' | 'C'
  severity: Severity;
  dom_freq: number;     // 지배 주파수 (Hz)
  sfm: number;          // Spectral Flatness Measure
  rms_dev: number;      // RMS Spectral Deviation
  top8_bins: number[];  // FFT 상위 8개 빈 진폭
  rssi: number;         // dBm (Gateway 노드는 0)
  online: boolean;
}

/** BLE Mesh 링크 (WebSocket 페이로드 내 links[]) */
export interface MeshLink {
  src: string;
  dst: string;
  rssi: number;
}

/** WebSocket 전체 페이로드 (PRD §5.4) */
export interface DashboardState {
  nodes: NodeState[];
  links: MeshLink[];
  ts: number;           // Unix timestamp
}

/** Three.js 씬에 전달되는 제어 커맨드 */
export interface MotorCommand {
  targetRPM: number;
  severity: Severity;
}
