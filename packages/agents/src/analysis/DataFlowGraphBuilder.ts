// SPEC §5.2.c — Data flow graph.
// Builds `producer → consumer` edges from CF constructs that carry implicit state:
//   • `cf_export VAR=value` in one step reads VAR in a later step
//   • Shared volume writes in step A become reads in step B (when A appears before B)
// Each edge becomes a data-flow fact the AnalysisAgent surfaces and the PlanningAgent
// uses to decide which artefact/output to recommend.

import { DataFlowEdge, DetectedConstruct, parseYaml } from '@cf-migrate/core';

export interface DataFlowInput {
  pipelinePath: string;
  rawYaml: string;
  constructs: DetectedConstruct[];
}

export class DataFlowGraphBuilder {
  build(input: DataFlowInput): DataFlowEdge[] {
    const edges: DataFlowEdge[] = [];
    const stepOrder = extractStepOrder(input.rawYaml);

    edges.push(...this.cfExportEdges(input.constructs, stepOrder));
    edges.push(...this.volumeEdges(input.constructs, input.rawYaml, stepOrder));

    return edges;
  }

  /** For each `cf_export KEY=VALUE` in step A, any later step that references `$KEY` or
   *  `${{KEY}}` is assumed to consume it. */
  private cfExportEdges(constructs: DetectedConstruct[], order: string[]): DataFlowEdge[] {
    const out: DataFlowEdge[] = [];
    const exports = constructs.filter((c) => c.type === 'cf_export');

    const orderIndex = new Map(order.map((name, i) => [name, i]));

    for (const exp of exports) {
      const producer = exp.stepName ?? '';
      const raw = typeof exp.rawValue === 'string' ? exp.rawValue : '';
      const keyMatch = raw.match(/cf_export\s+(?:-?\w+\s+)*([A-Z_][A-Z0-9_]*)/);
      const key = keyMatch?.[1];
      if (!key || !producer) continue;

      const producerIdx = orderIndex.get(producer) ?? 0;
      for (const consumer of order.slice(producerIdx + 1)) {
        out.push({
          producerStep: producer,
          consumerStep: consumer,
          dataType: 'cf_export',
          key,
        });
      }
    }
    return out;
  }

  /** Volume edges are conservative: if any step uses `/codefresh/volume` or the CF
   *  volume variable, assume every downstream step that references the same path is a
   *  consumer. */
  private volumeEdges(
    constructs: DetectedConstruct[],
    raw: string,
    order: string[],
  ): DataFlowEdge[] {
    const vols = constructs.filter((c) => c.type === 'volumes.shared');
    if (vols.length === 0) return [];

    const stepRangesByLine = stepLineRanges(raw);

    // Build producer/consumer sets by scanning each step's line range for volume refs.
    const usesVolume = new Map<string, boolean>();
    for (const step of order) {
      const range = stepRangesByLine.get(step);
      if (!range) continue;
      const lines = raw.split('\n').slice(range.start - 1, range.end);
      usesVolume.set(step, lines.some((l) => /\/codefresh\/volume|\$\{\{CF_VOLUME_PATH\}\}/.test(l)));
    }

    const touchers = order.filter((s) => usesVolume.get(s));
    const out: DataFlowEdge[] = [];
    for (let i = 0; i < touchers.length; i++) {
      for (let j = i + 1; j < touchers.length; j++) {
        out.push({
          producerStep: touchers[i],
          consumerStep: touchers[j],
          dataType: 'volume',
          key: '/codefresh/volume',
        });
      }
    }
    return out;
  }
}

function extractStepOrder(raw: string): string[] {
  try {
    const parsed = parseYaml<{ steps?: Record<string, unknown> }>(raw);
    if (!parsed?.steps || typeof parsed.steps !== 'object') return [];
    return Object.keys(parsed.steps);
  } catch {
    return [];
  }
}

/** Rough line ranges for top-level steps by scanning indentation. Sufficient for
 *  flagging which block a given line falls inside; not a full YAML position map. */
function stepLineRanges(raw: string): Map<string, { start: number; end: number }> {
  const out = new Map<string, { start: number; end: number }>();
  const lines = raw.split('\n');
  let inSteps = false;
  let indent = -1;
  let currentStep: string | null = null;
  let currentStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^steps\s*:/.test(line)) {
      inSteps = true;
      indent = -1;
      continue;
    }
    if (!inSteps) continue;

    const ws = line.match(/^(\s*)\S/);
    if (!ws) continue;
    const ind = ws[1].length;

    // Detect the step indent level on first seen entry.
    if (indent < 0 && ind > 0) indent = ind;

    // A new step begins at exactly `indent` columns with `name:` pattern.
    if (ind === indent && /^\s*[A-Za-z0-9_.-]+\s*:\s*$/.test(line)) {
      if (currentStep) out.set(currentStep, { start: currentStart, end: i });
      currentStep = line.trim().replace(/:\s*$/, '');
      currentStart = i + 1;
    } else if (ind === 0 && !/^\s*$/.test(line)) {
      // Left the steps: block entirely.
      if (currentStep) out.set(currentStep, { start: currentStart, end: i });
      currentStep = null;
      inSteps = false;
    }
  }
  if (currentStep) out.set(currentStep, { start: currentStart, end: lines.length });
  return out;
}
