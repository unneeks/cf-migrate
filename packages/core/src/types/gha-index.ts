// SPEC §4.7 — GHA org index.

export interface StepSummary {
  name?: string;
  usesAction?: string;
  isRun: boolean;
}

export interface JobSummary {
  id: string;
  runnerLabel: string;
  needs: string[];
  steps: StepSummary[];
  services: string[];
  environment?: string;
  isMatrix: boolean;
}

export interface WorkflowSummary {
  name: string;
  filePath: string;
  triggers: string[];
  jobs: JobSummary[];
  actionsUsed: string[];
  environmentsReferenced: string[];
  secretsReferenced: string[];
  varsReferenced: string[];
  isReusable: boolean;
}

export interface RepoWorkflowSummary {
  repoPath: string;
  workflows: WorkflowSummary[];
}

export interface ReusableWorkflowRef {
  filePath: string;
  name: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, string>;
  secrets: string[];
}

export interface RecurringPattern {
  description: string;
  occurrenceCount: number;
  representativeYaml: string;
  suggestAsKBSnippet: boolean;
}

export interface OrgWorkflowIndex {
  indexedAt: Date;
  repositories: RepoWorkflowSummary[];
  runnerCatalog: string[];
  actionVersions: Record<string, string>;
  environmentNames: string[];
  reusableWorkflows: ReusableWorkflowRef[];
  secretNamePatterns: string[];
  recurringPatterns: RecurringPattern[];
}

export function emptyIndex(): OrgWorkflowIndex {
  return {
    indexedAt: new Date(0),
    repositories: [],
    runnerCatalog: ['ubuntu-latest'],
    actionVersions: {},
    environmentNames: [],
    reusableWorkflows: [],
    secretNamePatterns: [],
    recurringPatterns: [],
  };
}
