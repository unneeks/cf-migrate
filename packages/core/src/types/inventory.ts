// SPEC §4.1 — Discovery output.

// ── Codefresh REST API pipeline schema ───────────────────────────────────────
// Shape returned by GET /api/pipelines/{name_or_id}.
// The `spec` block mirrors the YAML pipeline spec; `metadata.originalYamlString`
// carries the verbatim YAML the user authored (most reliable source of truth).

export interface CfApiMetadata {
  /** Pipeline UUID, e.g. "698ab19f426376c9578bffd5" */
  id: string;
  /** Full pipeline name: "PROJECT/pipeline-name" */
  name: string;
  project?: string;
  projectId?: string;
  accountId?: string;
  /** Incremented on every save. */
  revision?: number;
  created_at?: string;
  updated_at?: string;
  labels?: { tags?: string[] };
  /** Verbatim YAML as authored — preferred source for rawYaml. */
  originalYamlString?: string;
  concurrency?: number;
  isPublic?: boolean;
  terminationPolicy?: unknown[];
  deprecatedNotifyOnSuccess?: boolean;
  usesInternalRegistry?: boolean;
}

export interface CfApiVariable {
  key: string;
  value: string;
  encrypted?: boolean;
}

export interface CfApiTrigger {
  type: 'git' | 'cron' | 'registry' | string;
  repo?: string;
  events?: string[];
  branchRegex?: string;
  branchRegexInput?: string;
  provider?: string;
  name?: string;
  disabled?: boolean;
  options?: Record<string, unknown>;
}

export interface CfApiSpec {
  triggers?: CfApiTrigger[];
  contexts?: string[];
  variables?: CfApiVariable[];
  stages?: string[];
  steps?: Record<string, unknown>;
  mode?: 'sequential' | 'parallel';
  failFast?: boolean;
  hooks?: Record<string, unknown>;
  terminationPolicy?: unknown[];
}

export interface CfApiPipeline {
  version: string;
  kind: 'pipeline';
  metadata: CfApiMetadata;
  spec: CfApiSpec;
}

// ── Discovery output types ────────────────────────────────────────────────────

export interface PipelineFile {
  path: string;
  relativePath: string;
  name: string;
  /** Always a valid CF YAML string — even when source was a JSON API export. */
  rawYaml: string;
  lastModified: Date;
  /** 'json' when the file was a Codefresh API export; 'yaml' (default) otherwise. */
  sourceFormat?: 'yaml' | 'json';
  /** Populated when sourceFormat === 'json'; preserves API metadata (id, revision …). */
  apiMeta?: CfApiMetadata;
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
