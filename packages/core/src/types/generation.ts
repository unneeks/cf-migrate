// SPEC §4.5 — Generated workflow & validation.

export interface ValidationError {
  file: string;
  line?: number;
  column?: number;
  message: string;
  severity: 'error' | 'warning';
  ruleId?: string;
}

export interface SecurityIssue {
  type: 'excessive-permissions' | 'secret-exposure' | 'missing-oidc' | 'unpinned-action' | 'injection';
  file: string;
  line?: number;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  suggestedFix?: string;
}

export interface ValidationResult {
  passed: boolean;
  schemaErrors: ValidationError[];
  lintErrors: ValidationError[];
  securityIssues: SecurityIssue[];
  missingCFConstructs: string[];
}

export interface GeneratedWorkflow {
  workflowName: string;
  filename: string;
  yamlContent: string;
  sourceItems: string[];
  usedKbItems: string[];
  generatedAt: Date;
  validationResult?: ValidationResult;
}

export interface GenerationManifest {
  planId: string;
  generatedAt: Date;
  workflows: GeneratedWorkflow[];
  totalActionsUsed: string[];
  securityImprovements: string[];
}
