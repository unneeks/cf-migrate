// SPEC §4.1 — Discovery output.

export interface PipelineFile {
  path: string;
  relativePath: string;
  name: string;
  rawYaml: string;
  lastModified: Date;
}

export interface DependencyEdge {
  from: string;
  to: string;
  type: 'step-template' | 'shared-library';
}

export interface PipelineInventory {
  workspacePath: string;
  discoveredAt: Date;
  pipelines: PipelineFile[];
  dependencyGraph: DependencyEdge[];
  totalStepCount: number;
  estimatedComplexity: 'low' | 'medium' | 'high';
}
