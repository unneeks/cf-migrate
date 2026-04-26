// SPEC §4.3 — Analysis result.

import type { DetectedConstruct, DataFlowEdge } from './cf-constructs';

export interface ParallelismGroup {
  steps: string[];
  isTrue: boolean;
  sharedState: boolean;
}

export interface DockerBuildChain {
  buildStep: string;
  pushStep?: string;
  imageName: string;
  registryType: 'ecr' | 'gcr' | 'ghcr' | 'dockerhub' | 'custom';
  multiPlatform: boolean;
  cacheStrategy: 'none' | 'layer' | 'buildkit';
}

export interface DeployTarget {
  stepName: string;
  environment: string;
  method: 'helm' | 'kubectl' | 'custom';
  hasApprovalPolicy: boolean;
  hasRollbackStrategy: boolean;
}

export interface SecretRef {
  name: string;
  classification: 'cloud-credential' | 'api-key' | 'registry-credential' | 'unknown';
  source: 'context' | 'env' | 'inline';
  sensitivity: 'high' | 'medium' | 'low';
}

export interface PluginRef {
  pluginName: string;
  version?: string;
  inputs: Record<string, unknown>;
  outputs: string[];
  marketplaceEquivalent?: string;
  requiresCompositeAction: boolean;
}

export interface ManualInput {
  name: string;
  type: 'string' | 'boolean' | 'choice';
  required: boolean;
  default?: string;
  options?: string[];
}

export interface TriggerDef {
  type: 'push' | 'pull_request' | 'schedule' | 'manual' | 'api';
  branchPattern?: string;
  cronExpression?: string;
  manualInputs?: ManualInput[];
}

export interface ProposedWorkflow {
  name: string;
  filename: string;
  cfSourceSteps: string[];
  trigger: string[];
  estimatedJobCount: number;
}

export interface StructuralRecommendation {
  rationale: string;
  proposedWorkflows: ProposedWorkflow[];
  crossCuttingConcerns: string[];
}

export interface AnalysisResult {
  id: string;
  pipelinePath: string;
  analysedAt: Date;
  constructs: DetectedConstruct[];
  dataFlowGraph: DataFlowEdge[];
  parallelismGroups: ParallelismGroup[];
  dockerTopology: DockerBuildChain[];
  deployTopology: DeployTarget[];
  secretsInventory: SecretRef[];
  pluginInventory: PluginRef[];
  triggerInventory: TriggerDef[];
  structuralRecommendation: StructuralRecommendation;
  complexityScore: number;
  estimatedWorkflowCount: number;
  proposedWorkflowNames: string[];
  /** Non-obvious observations from the LLM pass; never secrets. */
  llmNotes?: string[];
}
