import * as d3 from 'd3';
import type { DashboardState } from '../types';

/* ─────────────────────────────────────────────────────────
   topology.ts  —  D3.js BLE Mesh topology graph
   PRD §5.4: Force-directed graph
   - Nodes A/B/C: green=online, gray=offline
   - Links: stroke-width proportional to RSSI strength
   - Labels: roll/pitch angles below each node
───────────────────────────────────────────────────────── */

// Fixed normalized positions [x, y] in [0..1] — A left, B center, C right
const NODE_POS: Record<string, [number, number]> = {
  A: [0.20, 0.50],
  B: [0.50, 0.50],
  C: [0.80, 0.50],
};

const NODE_R          = 26;
const COL_ONLINE      = '#3fb950';
const COL_OFFLINE     = '#484f58';
const COL_STROKE_ON   = '#a5f3a5';
const COL_STROKE_OFF  = '#6e7681';
const COL_LINK        = '#58a6ff';
const COL_LABEL_MUTED = '#8b949e';
const COL_LABEL_DIM   = '#484f58';

// RSSI → stroke-width  (-80 dBm weak=1.5px … -30 dBm strong=5px)
const rssiScale = d3.scaleLinear<number>().domain([-80, -30]).range([1.5, 5]).clamp(true);

type SVGSel = d3.Selection<SVGSVGElement, unknown, null, undefined>;
type GSel   = d3.Selection<SVGGElement,   unknown, null, undefined>;

let svg:    SVGSel;
let gLinks: GSel;
let gNodes: GSel;
let W = 0;
let H = 0;

/** Convert normalized position to pixel coordinates */
function px(id: string): [number, number] {
  const [nx, ny] = NODE_POS[id] ?? [0.5, 0.5];
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

  // ── Links ──────────────────────────────────────────────────────────
  type LinkDatum = DashboardState['links'][0];

  const linkGroups = gLinks
    .selectAll<SVGGElement, LinkDatum>('g.link')
    .data(state.links, d => `${d.src}-${d.dst}`);

  // Enter
  const linkEnter = linkGroups.enter().append('g').attr('class', 'link');
  linkEnter.append('line');
  linkEnter.append('text')
    .attr('text-anchor', 'middle')
    .attr('fill', COL_LABEL_MUTED)
    .attr('font-size', '10px')
    .attr('font-family', 'monospace');

  // Update (enter + existing)
  const linkMerge = linkEnter.merge(linkGroups);

  linkMerge.select<SVGLineElement>('line')
    .attr('stroke',         COL_LINK)
    .attr('stroke-opacity', 0.7)
    .attr('stroke-linecap', 'round')
    .attr('stroke-width', d => rssiScale(d.rssi))
    .attr('x1', d => px(d.src)[0])
    .attr('y1', d => px(d.src)[1])
    .attr('x2', d => px(d.dst)[0])
    .attr('y2', d => px(d.dst)[1]);

  linkMerge.select<SVGTextElement>('text')
    .attr('x', d => (px(d.src)[0] + px(d.dst)[0]) / 2)
    .attr('y', d => (px(d.src)[1] + px(d.dst)[1]) / 2 - 10)
    .text(d => `${d.rssi} dBm`);

  linkGroups.exit().remove();

  // ── Nodes ──────────────────────────────────────────────────────────
  type NodeDatum = DashboardState['nodes'][0];

  const nodeGroups = gNodes
    .selectAll<SVGGElement, NodeDatum>('g.node')
    .data(state.nodes, d => d.id);

  // Enter
  const nodeEnter = nodeGroups.enter().append('g').attr('class', 'node');

  nodeEnter.append('circle')
    .attr('r', NODE_R)
    .attr('stroke-width', 2.5);

  // Node ID label (centered in circle)
  nodeEnter.append('text')
    .attr('class', 'id-label')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .attr('font-size', '16px')
    .attr('font-weight', '700')
    .attr('font-family', 'monospace')
    .attr('fill', '#0d1117')
    .attr('pointer-events', 'none');

  // Roll/Pitch label below circle
  nodeEnter.append('text')
    .attr('class', 'angle-label')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'hanging')
    .attr('font-size', '9px')
    .attr('font-family', 'monospace')
    .attr('pointer-events', 'none');

  // RSSI label above circle
  nodeEnter.append('text')
    .attr('class', 'rssi-label')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'auto')
    .attr('font-size', '9px')
    .attr('font-family', 'monospace')
    .attr('pointer-events', 'none');

  // Update (enter + existing)
  const nodeMerge = nodeEnter.merge(nodeGroups);

  nodeMerge.attr('transform', d => {
    const [x, y] = px(d.id);
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
