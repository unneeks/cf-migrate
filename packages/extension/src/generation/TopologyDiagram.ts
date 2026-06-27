// Renders a small boxes-and-arrows topology diagram (as an SVG + HTML label layer) for the
// "authoring plane / execution plane" view in the Map Run diff panel:
//
//   Codefresh side:  GitHub repo (if the pipeline YAML is git-tracked) → CF project →
//                     template pipeline → instance pipelines (if this is a template group).
//   GitHub side:      GitHub repo → workflow file → (if centralised as a reusable workflow)
//                     the caller workflows that `uses:` it, each annotated with where it
//                     actually executes (a `workflow_call`'d workflow always runs in the
//                     CALLER's repo/context, never the repo that merely hosts its YAML —
//                     that's the one nuance worth a label, not just a box).
//
// Pure layout function, no `vscode` dependency, so it's unit-testable like the other
// generation modules.

export type TopoNodeKind = 'repo' | 'account' | 'pipeline' | 'template' | 'instance' | 'workflow' | 'reusable' | 'caller';

export interface TopoNode {
  id: string;
  label: string;
  sublabel?: string;
  kind: TopoNodeKind;
  rank: number;
  /** True when this node represents something not yet generated (e.g. a caller workflow
   *  that doesn't exist on disk yet) — rendered dashed/muted instead of solid. */
  proposed?: boolean;
}

export interface TopoEdge {
  from: string;
  to: string;
  label?: string;
  proposed?: boolean;
}

export interface TopoGraph {
  title: string;
  nodes: TopoNode[];
  edges: TopoEdge[];
}

const BOX_W = 196;
const BOX_H = 56;
const H_GAP = 24;
const V_GAP = 48;
const MARGIN = 24;

interface Layout {
  width: number;
  height: number;
  positions: Map<string, { x: number; y: number }>;
}

function layout(nodes: TopoNode[]): Layout {
  const byRank = new Map<number, TopoNode[]>();
  for (const n of nodes) {
    const arr = byRank.get(n.rank) ?? [];
    arr.push(n);
    byRank.set(n.rank, arr);
  }
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  const positions = new Map<string, { x: number; y: number }>();
  let maxRowWidth = 0;

  for (const rank of ranks) {
    const row = byRank.get(rank)!;
    const rowWidth = row.length * BOX_W + (row.length - 1) * H_GAP;
    maxRowWidth = Math.max(maxRowWidth, rowWidth);
    const y = MARGIN + rank * (BOX_H + V_GAP);
    row.forEach((n, i) => {
      const x = (rowWidth - (row.length * BOX_W + (row.length - 1) * H_GAP)) / 2 + i * (BOX_W + H_GAP);
      positions.set(n.id, { x, y });
    });
  }

  // Re-center every row against the widest row now that we know it.
  for (const rank of ranks) {
    const row = byRank.get(rank)!;
    const rowWidth = row.length * BOX_W + (row.length - 1) * H_GAP;
    const offset = (maxRowWidth - rowWidth) / 2;
    row.forEach((n) => {
      const pos = positions.get(n.id)!;
      positions.set(n.id, { x: pos.x + offset, y: pos.y });
    });
  }

  const height = MARGIN * 2 + ranks.length * BOX_H + Math.max(0, ranks.length - 1) * V_GAP;
  return { width: maxRowWidth + MARGIN * 2, height, positions };
}

function esc(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const KIND_COLOR: Record<TopoNodeKind, string> = {
  repo: '#4ea6ff',
  account: '#9b6dff',
  pipeline: '#e89c3c',
  template: '#3cc878',
  instance: '#e6b43c',
  workflow: '#4ea6ff',
  reusable: '#3cc878',
  caller: '#e6b43c',
};

/** Renders one topology graph as a self-contained `<div>` (title + SVG canvas, offset by
 *  MARGIN so node positions map 1:1 onto absolutely-positioned label overlays). */
export function renderTopologyGraph(graph: TopoGraph, idPrefix: string): string {
  const { width, height, positions } = layout(graph.nodes);
  const pos = (id: string) => positions.get(id) ?? { x: 0, y: 0 };

  const edgesSvg = graph.edges.map((e) => {
    const a = pos(e.from);
    const b = pos(e.to);
    const x1 = a.x + BOX_W / 2 + MARGIN;
    const y1 = a.y + BOX_H + MARGIN;
    const x2 = b.x + BOX_W / 2 + MARGIN;
    const y2 = b.y + MARGIN;
    const midY = (y1 + y2) / 2;
    const dash = e.proposed ? ' stroke-dasharray="4,4"' : '';
    const color = e.proposed ? '#888' : 'var(--vscode-charts-blue, #4ea6ff)';
    let labelSvg = '';
    if (e.label) {
      const lx = (x1 + x2) / 2;
      labelSvg = `<rect x="${lx - e.label.length * 3.4 - 4}" y="${midY - 9}" width="${e.label.length * 6.8 + 8}" height="16" fill="var(--vscode-editor-background,#1e1e1e)" opacity="0.9"/>` +
        `<text x="${lx}" y="${midY + 3}" text-anchor="middle" font-size="10" fill="var(--vscode-descriptionForeground,#999)">${esc(e.label)}</text>`;
    }
    return `<path d="M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}" stroke="${color}" stroke-width="1.5" fill="none"${dash}/>` +
      `<circle cx="${x2}" cy="${y2}" r="3" fill="${color}"/>` + labelSvg;
  }).join('');

  const nodesHtml = graph.nodes.map((n) => {
    const p = pos(n.id);
    const col = KIND_COLOR[n.kind];
    const dashed = n.proposed ? `border-style:dashed;opacity:.7;` : '';
    return `<div class="topo-box" style="left:${p.x + MARGIN}px;top:${p.y + MARGIN}px;width:${BOX_W}px;height:${BOX_H}px;border-color:${col};${dashed}">
      <div class="topo-box-label" style="color:${col}">${esc(n.label)}</div>
      ${n.sublabel ? `<div class="topo-box-sub">${esc(n.sublabel)}</div>` : ''}
    </div>`;
  }).join('');

  return `<div class="topo-graph">
    <div class="topo-graph-title">${esc(graph.title)}</div>
    <div class="topo-canvas" style="width:${width}px;height:${height}px" id="${idPrefix}-canvas">
      <svg width="${width}" height="${height}" style="position:absolute;top:0;left:0;pointer-events:none">${edgesSvg}</svg>
      ${nodesHtml}
    </div>
  </div>`;
}
