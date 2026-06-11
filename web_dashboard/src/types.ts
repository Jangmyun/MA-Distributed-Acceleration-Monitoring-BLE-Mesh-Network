/* ─────────────────────────────────────────────
   Shared type definitions  (PRD §4.2 / §4.3 payload spec)
───────────────────────────────────────────── */

/** State of a single BLE Mesh node (inside WebSocket payload nodes[]) */
export interface NodeState {
  id: string;       // 'A' | 'B' | 'C'
  x: number;        // centiunits (val × 100 = m/s²)
  y: number;
  z: number;
  roll: number;     // degrees — atan2(y, z)
  pitch: number;    // degrees — atan2(-x, √(y²+z²))
  rssi: number;     // dBm  (0 for the Gateway node itself)
  online: boolean;
}

/** BLE Mesh link (inside WebSocket payload links[]) */
export interface MeshLink {
  src: string;
  dst: string;
  rssi: number;   // dBm
}

/** Full WebSocket payload (PRD §4.3) */
export interface DashboardState {
  nodes: NodeState[];
  links: MeshLink[];
  ts: number;       // Unix timestamp
}
