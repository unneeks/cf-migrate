// SPEC §4.4 — Migration plan & approval.

import type { CFConstructType, ConfidenceTier } from './cf-constructs';
import type { ProposedWorkflow } from './analysis';

export type PlanItemType =
  | 'structural'
  | 'construct-mapping'
  | 'security'
  | 'docker'
  | 'deploy'
  | 'plugin'
  | 'secret-migration';

export type PlanItemStatus = 'pending' | 'approved' | 'approved-modified' | 'rejected';
export type Complexity = 'low' | 'medium' | 'high';

export interface PlanItem {
  id: string;
  sequenceNumber: number;
  type: PlanItemType;
  cfConstructRef: {
    filePath: string;
    lineStart: number;
    lineEnd: number;
    constructType: CFConstructType;
    constructName: string;
  };
  ghaRecommendation: {
    description: string;
    actionOrPattern: string;
    parameters: Record<string, string>;
  };
  rationale: string;
  confidenceScore: number;
  confidenceTier: ConfidenceTier;
  complexity: Complexity;
  kbSnippetId?: string;
  /** Target workflow filename (e.g. build.yml) — assigned during planning. */
  targetWorkflow?: string;
  requiresReview: boolean;
  status: PlanItemStatus;
  reviewerNotes?: string;
  reviewedBy?: string;
  reviewedAt?: Date;
  proposedModification?: string;
}

export type RecommendationType =
  | 'structural-dedup'
  | 'security-oidc'
  | 'plugin-gap'
  | 'org-standardisation'
  | 'action-version'
  | 'runner-optimisation'
  | 'reusable-workflow-exists';

export interface Recommendation {
  id: string;
  type: RecommendationType;
  title: string;
  description: string;
  severity: 'info' | 'suggestion' | 'warning';
  actionable: boolean;
  suggestedPlanItem?: Partial<PlanItem>;
}

export interface ApprovalState {
  status: 'pending' | 'partially-approved' | 'approved' | 'rejected';
  approvedCount: number;
  pendingCount: number;
  rejectedCount: number;
  approvedAt?: Date;
  approvedBy?: string;
  rejectionReason?: string;
}

export interface MigrationPlan {
  id: string;
  pipelinePath: string;
  generatedAt: Date;
  generatedBy: 'llm' | 'deterministic' | 'hybrid';
  analysisResultId: string;
  items: PlanItem[];
  recommendations: Recommendation[];
  proposedWorkflows: ProposedWorkflow[];
  approvalState: ApprovalState;
  version: number;
}
