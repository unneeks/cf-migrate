// SPEC §4.2 — Codefresh construct identity & confidence tiering.

export type CFConstructType =
  | 'pipeline.stages'
  | 'step.freestyle'
  | 'step.build'
  | 'step.push'
  | 'step.deploy'
  | 'step.git-clone'
  | 'step.composition'
  | 'step.parallel'
  | 'volumes.shared'
  | 'cf_export'
  | 'step.when'
  | 'triggers'
  | 'step.retry'
  | 'step.hooks'
  | 'spec.contexts'
  | 'plugin'
  | 'fail_fast'
  | 'noCache';

export const ALL_CF_CONSTRUCT_TYPES: CFConstructType[] = [
  'pipeline.stages',
  'step.freestyle',
  'step.build',
  'step.push',
  'step.deploy',
  'step.git-clone',
  'step.composition',
  'step.parallel',
  'volumes.shared',
  'cf_export',
  'step.when',
  'triggers',
  'step.retry',
  'step.hooks',
  'spec.contexts',
  'plugin',
  'fail_fast',
  'noCache',
];

/**
 * A — deterministic (≥ 0.95), B — contextual (0.65–0.95), C — complex (< 0.65).
 */
export type ConfidenceTier = 'A' | 'B' | 'C';

export interface DetectedConstruct {
  type: CFConstructType;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  rawValue: unknown;
  stepName?: string;
  confidenceTier: ConfidenceTier;
}

export interface DataFlowEdge {
  producerStep: string;
  consumerStep: string;
  dataType: 'volume' | 'cf_export' | 'artifact';
  key: string;
}

export function tierForConstruct(t: CFConstructType): ConfidenceTier {
  switch (t) {
    case 'triggers':
    case 'step.git-clone':
    case 'step.retry':
    case 'step.hooks':
    case 'fail_fast':
    case 'noCache':
    case 'step.push':
      return 'A';
    case 'step.freestyle':
    case 'step.build':
    case 'step.deploy':
    case 'step.composition':
    case 'step.parallel':
    case 'step.when':
    case 'spec.contexts':
    case 'plugin':
      return 'B';
    case 'volumes.shared':
    case 'cf_export':
    case 'pipeline.stages':
      return 'C';
  }
}
