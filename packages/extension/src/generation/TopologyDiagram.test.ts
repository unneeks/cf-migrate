import { describe, expect, it } from 'vitest';

import { renderTopologyGraph, type TopoGraph } from './TopologyDiagram';

describe('renderTopologyGraph', () => {
  const graph: TopoGraph = {
    title: 'Codefresh Topology',
    nodes: [
      { id: 'repo', label: 'github.com/org/repo', kind: 'repo', rank: 0 },
      { id: 'project', label: 'CF Project: PROD', kind: 'account', rank: 1 },
      { id: 'template', label: 'Template: billing-deployment', kind: 'template', rank: 2 },
      { id: 'inst1', label: 'NOTIFICATIONS/notifications-deployment', kind: 'instance', rank: 3 },
      { id: 'inst2', label: 'PROD/crm-deployment', kind: 'instance', rank: 3 },
    ],
    edges: [
      { from: 'repo', to: 'project', label: 'authored in' },
      { from: 'project', to: 'template', label: 'contains' },
      { from: 'template', to: 'inst1', label: 'shared structure' },
      { from: 'template', to: 'inst2', label: 'shared structure' },
    ],
  };

  it('renders one box per node and includes its label', () => {
    const html = renderTopologyGraph(graph, 'cf');
    expect(html.match(/class="topo-box"/g)).toHaveLength(5);
    expect(html).toContain('Template: billing-deployment');
    expect(html).toContain('NOTIFICATIONS/notifications-deployment');
  });

  it('renders one connector path per edge with its label', () => {
    const html = renderTopologyGraph(graph, 'cf');
    expect(html.match(/<path /g)).toHaveLength(4);
    expect(html).toContain('authored in');
    expect(html).toContain('shared structure');
  });

  it('escapes HTML-significant characters in labels', () => {
    const malicious: TopoGraph = {
      title: 't',
      nodes: [{ id: 'a', label: '<script>alert(1)</script>', kind: 'repo', rank: 0 }],
      edges: [],
    };
    const html = renderTopologyGraph(malicious, 'x');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('marks proposed (not-yet-generated) nodes and edges distinctly', () => {
    const proposed: TopoGraph = {
      title: 't',
      nodes: [
        { id: 'a', label: 'A', kind: 'reusable', rank: 0 },
        { id: 'b', label: 'B (not yet generated)', kind: 'caller', rank: 1, proposed: true },
      ],
      edges: [{ from: 'a', to: 'b', label: 'would use', proposed: true }],
    };
    const html = renderTopologyGraph(proposed, 'x');
    expect(html).toContain('border-style:dashed');
    expect(html).toContain('stroke-dasharray');
  });

  it('lays out siblings on the same rank side by side without overlapping x positions', () => {
    const html = renderTopologyGraph(graph, 'cf');
    const lefts = [...html.matchAll(/left:(\d+)px;top:(\d+)px;width:196px;height:56px/g)].map((m) => ({
      left: Number(m[1]),
      top: Number(m[2]),
    }));
    const rank3 = lefts.filter((p) => p.top === lefts[lefts.length - 1].top);
    expect(rank3).toHaveLength(2);
    expect(rank3[0].left).not.toBe(rank3[1].left);
  });

  it('produces a stable, deterministic canvas size for the same graph', () => {
    const a = renderTopologyGraph(graph, 'cf');
    const b = renderTopologyGraph(graph, 'cf');
    expect(a).toBe(b);
  });
});
