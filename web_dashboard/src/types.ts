/* ─────────────────────────────────────────────
   Shared type definitions (PRD §5.1 / §5.4 payload spec)
───────────────────────────────────────────── */

export type Severity = 'normal' | 'warning' | 'critical';

/** State of a single BLE Mesh node (inside WebSocket payload nodes[]) */
export interface NodeState {
  id: string;           // 'A' | 'B' | 'C'
  severity: Severity;
  dom_freq: number;     // Dominant frequency (Hz)
  sfm: number;          // Spectral Flatness Measure
  rms_dev: number;      // RMS Spectral Deviation
  top8_bins: number[];  // Top-8 FFT bin amplitudes
  rssi: number;         // dBm (0 for the Gateway node)
  online: boolean;
}

/** BLE Mesh link (inside WebSocket payload links[]) */
export interface MeshLink {
  src: string;
  dst: string;
  rssi: number;
}

/** Full WebSocket payload (PRD §5.4) */
export interface DashboardState {
  nodes: NodeState[];
  links: MeshLink[];
  ts: number;           // Unix timestamp
}

/** Control command sent to the Three.js scene */
export interface MotorCommand {
  targetRPM: number;
  severity: Severity;
}
