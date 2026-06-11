import * as d3 from 'd3';
import type { DashboardState } from '../types';

/* ─────────────────────────────────────────────────────────
   topology.ts  —  D3.js BLE Mesh topology graph
   - 노드 수에 따라 좌→우 균등 배치 (2개: 25%/75%, 3개: 20%/50%/80%)
   - 노드 색: green=online, gray=offline
   - 링크 굵기: RSSI 강도 비례
   - 노드 하단 레이블: roll/pitch 각도
───────────────────────────────────────────────────────── */

const NODE_R          = 26;
const COL_ONLINE      = '#3fb950';
const COL_OFFLINE     = '#484f58';
const COL_STROKE_ON   = '#a5f3a5';
const COL_STROKE_OFF  = '#6e7681';
const COL_LINK        = '#58a6ff';
const COL_LABEL_MUTED = '#8b949e';
const COL_LABEL_DIM   = '#484f58';

// RSSI → stroke-width  (-80 dBm 약함=1.5px … -30 dBm 강함=5px)
const rssiScale = d3.scaleLinear<number>().domain([-80, -30]).range([1.5, 5]).clamp(true);

type SVGSel = d3.Selection<SVGSVGElement, unknown, null, undefined>;
type GSel   = d3.Selection<SVGGElement,   unknown, null, undefined>;

let svg:    SVGSel;
let gLinks: GSel;
let gNodes: GSel;
let W = 0;
let H = 0;

// 현재 렌더링 중인 노드 ID 목록 (위치 계산용)
let currentNodeIds: string[] = [];

/** 연결된 노드 수에 따라 균등 수평 배치 좌표 계산 */
function computePositions(nodeIds: string[]): Record<string, [number, number]> {
  const sorted = [...nodeIds].sort();
  const n      = sorted.length;
  const result: Record<string, [number, number]> = {};
  sorted.forEach((id, i) => {
    result[id] = [(i + 1) / (n + 1), 0.50];
  });
  return result;
}

/** 정규화 좌표 → 픽셀 좌표 변환 */
function px(id: string, positions: Record<string, [number, number]>): [number, number] {
  const [nx, ny] = positions[id] ?? [0.5, 0.5];
  return [nx * W, ny * H];
}

export function initTopology(container: HTMLElement): void {
  svg = d3.select(container)
    .append('svg')
    .style('width', '100%')
    .style('height', '100%');

  gLinks = svg.append('g').attr('class', 'links');
  gNodes = svg.append('g').attr('class', 'nodes');

  const ro = new ResizeObserver(() => {
    W = container.clientWidth;
    H = container.clientHeight;
    svg.attr('width', W).attr('height', H);
  });
  ro.observe(container);

  W = container.clientWidth;
  H = container.clientHeight;
  svg.attr('width', W).attr('height', H);
}

export function updateTopology(state: DashboardState): void {
  if (!svg || W === 0 || H === 0) return;

  // 노드 목록 변경 시 위치 재계산
  const incomingIds = state.nodes.map(n => n.id);
  if (JSON.stringify(incomingIds.sort()) !== JSON.stringify(currentNodeIds.sort())) {
    currentNodeIds = incomingIds;
  }
  const positions = computePositions(currentNodeIds);

  // ── Links ──────────────────────────────────────────────────────────
  type LinkDatum = DashboardState['links'][0];

  const linkGroups = gLinks
    .selectAll<SVGGElement, LinkDatum>('g.link')
    .data(state.links, d => `${d.src}-${d.dst}`);

  const linkEnter = linkGroups.enter().append('g').attr('class', 'link');
  linkEnter.append('line');
  linkEnter.append('text')
    .attr('text-anchor', 'middle')
    .attr('fill', COL_LABEL_MUTED)
    .attr('font-size', '10px')
    .attr('font-family', 'monospace');

  const linkMerge = linkEnter.merge(linkGroups);

  linkMerge.select<SVGLineElement>('line')
    .attr('stroke',         COL_LINK)
    .attr('stroke-opacity', 0.7)
    .attr('stroke-linecap', 'round')
    .attr('stroke-width',   d => rssiScale(d.rssi))
    .attr('x1', d => px(d.src, positions)[0])
    .attr('y1', d => px(d.src, positions)[1])
    .attr('x2', d => px(d.dst, positions)[0])
    .attr('y2', d => px(d.dst, positions)[1]);

  linkMerge.select<SVGTextElement>('text')
    .attr('x', d => (px(d.src, positions)[0] + px(d.dst, positions)[0]) / 2)
    .attr('y', d => (px(d.src, positions)[1] + px(d.dst, positions)[1]) / 2 - 10)
    .text(d => `${d.rssi} dBm`);

  linkGroups.exit().remove();

  // ── Nodes ──────────────────────────────────────────────────────────
  type NodeDatum = DashboardState['nodes'][0];

  const nodeGroups = gNodes
    .selectAll<SVGGElement, NodeDatum>('g.node')
    .data(state.nodes, d => d.id);

  const nodeEnter = nodeGroups.enter().append('g').attr('class', 'node');

  nodeEnter.append('circle').attr('r', NODE_R).attr('stroke-width', 2.5);

  nodeEnter.append('text')
    .attr('class', 'id-label')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .attr('font-size', '16px')
    .attr('font-weight', '700')
    .attr('font-family', 'monospace')
    .attr('fill', '#0d1117')
    .attr('pointer-events', 'none');

  nodeEnter.append('text')
    .attr('class', 'angle-label')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'hanging')
    .attr('font-size', '9px')
    .attr('font-family', 'monospace')
    .attr('pointer-events', 'none');

  nodeEnter.append('text')
    .attr('class', 'rssi-label')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'auto')
    .attr('font-size', '9px')
    .attr('font-family', 'monospace')
    .attr('pointer-events', 'none');

  const nodeMerge = nodeEnter.merge(nodeGroups);

  nodeMerge.attr('transform', d => {
    const [x, y] = px(d.id, positions);
    return `translate(${x},${y})`;
  });

  nodeMerge.select<SVGCircleElement>('circle')
    .attr('fill',         d => d.online ? COL_ONLINE  : COL_OFFLINE)
    .attr('fill-opacity', d => d.online ? 0.90 : 0.45)
    .attr('stroke',       d => d.online ? COL_STROKE_ON : COL_STROKE_OFF);

  nodeMerge.select<SVGTextElement>('text.id-label')
    .text(d => d.id);

  nodeMerge.select<SVGTextElement>('text.angle-label')
    .attr('y',    NODE_R + 6)
    .attr('fill', d => d.online ? COL_LABEL_MUTED : COL_LABEL_DIM)
    .text(d => d.online
      ? `R ${d.roll >= 0 ? '+' : ''}${d.roll.toFixed(1)}°  P ${d.pitch >= 0 ? '+' : ''}${d.pitch.toFixed(1)}°`
      : 'offline');

  nodeMerge.select<SVGTextElement>('text.rssi-label')
    .attr('y',    -(NODE_R + 6))
    .attr('fill', d => d.online ? COL_LABEL_MUTED : COL_LABEL_DIM)
    .text(d => d.id === 'C' ? 'GW' : (d.online ? `${d.rssi} dBm` : ''));

  nodeGroups.exit().remove();
}
