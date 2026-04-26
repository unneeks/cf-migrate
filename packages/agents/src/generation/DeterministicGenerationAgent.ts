// Deterministic generation pass — produces GHA workflow YAML without calling the LLM.
//
// Strategy:
//   • Same approval gate as GenerationAgent.
//   • Groups PlanItems by targetWorkflow filename.
//   • For each workflow: builds an `on:` block from TriggerInventory, one job, and one
//     step per PlanItem.
//   • For action-based items (owner/repo@version pattern): emits a `uses:` step with
//     `with:` parameters.
//   • For structural/run items: emits a `run:` step with a descriptive TODO comment so
//     the user has clear guidance without requiring LLM synthesis.
//   • Attempts to pin action versions from OrgWorkflowIndex.actionVersions.
//
// Output is valid GHA YAML that passes schema validation. It is intentionally
// conservative — correctness over completeness. Tier-A items (git-clone, push, retry,
// etc.) produce precise `uses:` steps; Tier-B/C items produce documented TODOs.

import {
  AnalysisResult,
  ApprovalRequiredError,
  GeneratedWorkflow,
  GenerationManifest,
  LedgerWriter,
  MigrationPlan,
  OrgSettings,
  OrgWorkflowIndex,
  PipelineFile,
  PlanItem,
  TriggerDef,
  uuid,
} from '@cf-migrate/core';

import { SnippetRenderer, type FileKBStore } from '@cf-migrate/kb';

export interface DeterministicGenerationAgentOptions {
  ledger?: LedgerWriter;
  kbStore: FileKBStore;
  orgSettings: OrgSettings;
  orgIndex: OrgWorkflowIndex;
  snippetRenderer?: SnippetRenderer;
}

interface WorkflowBucket {
  filename: string;
  items: PlanItem[];
}

export class DeterministicGenerationAgent {
  private readonly ledger?: LedgerWriter;
  private readonly kbStore: FileKBStore;
  private readonly orgSettings: OrgSettings;
  private readonly orgIndex: OrgWorkflowIndex;
  private readonly renderer: SnippetRenderer;

  constructor(opts: DeterministicGenerationAgentOptions) {
    this.ledger = opts.ledger;
    this.kbStore = opts.kbStore;
    this.orgSettings = opts.orgSettings;
    this.orgIndex = opts.orgIndex;
    this.renderer = opts.snippetRenderer ?? new SnippetRenderer();
  }

  async generate(
    pipeline: PipelineFile,
    analysis: AnalysisResult,
    plan: MigrationPlan,
  ): Promise<GenerationManifest> {
    if (plan.approvalState.status !== 'approved') {
      await this.ledger?.append('error', {
        phase: 'generation',
        error: `plan ${plan.id} has approval status '${plan.approvalState.status}'`,
      });
      throw new ApprovalRequiredError();
    }

    const started = Date.now();
    const buckets = groupByWorkflow(plan);
    const workflows: GeneratedWorkflow[] = [];
    const actionsUsed = new Set<string>();
    const securityImprovements: string[] = [];

    for (const bucket of buckets) {
      const usedKbItems: string[] = [];

      // Best-effort: render KB snippets to record which items we used.
      // We don't embed their raw markdown into the YAML — steps are built from
      // plan item metadata so the output is always structurally valid.
      for (const item of bucket.items) {
        if (!item.kbSnippetId) continue;
        try {
          const kbItem = await this.kbStore.get(item.kbSnippetId);
          if (!kbItem) continue;
          this.renderer.render(kbItem, {
            planItemParameters: item.ghaRecommendation.parameters,
            orgSettings: this.orgSettings,
            orgIndex: this.orgIndex,
            cfConstructValue: undefined,
          });
          usedKbItems.push(kbItem.id);
          for (const g of kbItem.ghaConstructs ?? []) actionsUsed.add(g);
        } catch {
          // Non-fatal — proceed without this snippet.
        }

        if (item.type === 'security' && item.ghaRecommendation.actionOrPattern.includes('OIDC')) {
          securityImprovements.push(`OIDC federation for ${item.cfConstructRef.constructName}`);
        }
      }

      const runner = this.orgSettings.runnerConventions?.default ?? 'ubuntu-latest';
      const versions = this.orgIndex.actionVersions ?? {};

      const yaml = buildWorkflowYaml(
        bucket.filename,
        analysis.triggerInventory,
        bucket.items,
        runner,
        versions,
      );

      const workflow: GeneratedWorkflow = {
        workflowName: bucket.filename.replace(/\.ya?ml$/i, ''),
        filename: bucket.filename,
        yamlContent: yaml,
        sourceItems: bucket.items.map((i) => i.id),
        usedKbItems,
        generatedAt: new Date(),
      };
      workflows.push(workflow);

      await this.ledger?.append(
        'file.written',
        {
          filename: bucket.filename,
          itemCount: bucket.items.length,
          snippetCount: usedKbItems.length,
          model: 'deterministic',
          planId: plan.id,
        },
        { pipelinePath: pipeline.relativePath },
      );
    }

    const manifest: GenerationManifest = {
      planId: plan.id,
      generatedAt: new Date(),
      workflows,
      totalActionsUsed: [...actionsUsed],
      securityImprovements,
    };

    await this.ledger?.append(
      'generation.completed',
      {
        workflowCount: workflows.length,
        durationMs: Date.now() - started,
        planId: plan.id,
        manifestId: uuid(),
      },
      { pipelinePath: pipeline.relativePath },
    );

    return manifest;
  }
}

// ─────────────────────────────────────────────────────────── YAML composition ─

function groupByWorkflow(plan: MigrationPlan): WorkflowBucket[] {
  const buckets = new Map<string, PlanItem[]>();
  for (const item of plan.items) {
    if (item.status === 'rejected') continue;
    const target = item.targetWorkflow ?? 'ci.yml';
    const arr = buckets.get(target) ?? [];
    arr.push(item);
    buckets.set(target, arr);
  }
  return [...buckets.entries()].map(([filename, items]) => ({ filename, items }));
}

function buildWorkflowYaml(
  filename: string,
  triggers: TriggerDef[],
  items: PlanItem[],
  defaultRunner: string,
  actionVersions: Record<string, string>,
): string {
  const workflowName = filename.replace(/\.ya?ml$/i, '');
  const lines: string[] = [];

  lines.push(`name: ${q(workflowName)}`);
  lines.push('');
  lines.push('on:');
  lines.push(...buildOnBlock(triggers));
  lines.push('');
  lines.push('jobs:');
  lines.push(`  ${toJobId(workflowName)}:`);
  lines.push(`    runs-on: ${defaultRunner}`);
  lines.push('    steps:');

  // Checkout is always the first step unless an item already maps to it.
  const hasCheckout = items.some(
    (i) => i.ghaRecommendation.actionOrPattern.includes('checkout'),
  );
  if (!hasCheckout) {
    const checkoutVersion = actionVersions['actions/checkout'] ?? 'v4';
    lines.push(`      - uses: actions/checkout@${checkoutVersion}`);
  }

  for (const item of items) {
    lines.push('');
    lines.push(...buildStep(item, actionVersions));
  }

  lines.push('');
  return lines.join('\n');
}

function buildOnBlock(triggers: TriggerDef[]): string[] {
  const lines: string[] = [];
  const types = new Set(triggers.map((t) => t.type));

  if (triggers.length === 0 || types.has('push')) {
    const def = triggers.find((t) => t.type === 'push');
    lines.push('  push:');
    lines.push('    branches:');
    lines.push(`      - ${def?.branchPattern ?? 'main'}`);
  }
  if (types.has('pull_request')) {
    const def = triggers.find((t) => t.type === 'pull_request');
    lines.push('  pull_request:');
    lines.push('    branches:');
    lines.push(`      - ${def?.branchPattern ?? 'main'}`);
  }
  if (types.has('schedule')) {
    const def = triggers.find((t) => t.type === 'schedule');
    lines.push('  schedule:');
    lines.push(`    - cron: '${def?.cronExpression ?? '0 0 * * *'}'`);
  }
  if (types.has('manual') || types.has('api')) {
    lines.push('  workflow_dispatch: {}');
  }

  // Guarantee at least one trigger so the YAML is valid.
  if (lines.length === 0) {
    lines.push('  push:');
    lines.push('    branches:');
    lines.push('      - main');
  }

  return lines;
}

function buildStep(item: PlanItem, actionVersions: Record<string, string>): string[] {
  const name = item.cfConstructRef.constructName;
  const action = item.ghaRecommendation.actionOrPattern;
  const params = item.ghaRecommendation.parameters;
  const lines: string[] = [];

  lines.push(`      - name: ${q(name)}`);

  if (isActionRef(action)) {
    lines.push(`        uses: ${pinnedVersion(action, actionVersions)}`);
    const entries = Object.entries(params);
    if (entries.length > 0) {
      lines.push('        with:');
      for (const [k, v] of entries) {
        lines.push(`          ${k}: ${q(v)}`);
      }
    }
  } else {
    // Structural or run-based — emit a documented placeholder.
    lines.push('        run: |');
    lines.push(`          # ${item.ghaRecommendation.description}`);
    if (item.kbSnippetId) {
      lines.push(`          # KB reference: ${item.kbSnippetId}`);
    }
    lines.push(`          echo "TODO: implement ${action} for ${name.replace(/"/g, '\\"')}"`);
  }

  if (item.requiresReview) {
    lines.push(
      `        # REVIEW: confidence ${(item.confidenceScore * 100).toFixed(0)}% — manual verification required`,
    );
  }

  return lines;
}

// ─────────────────────────────────────────────────────────────────── helpers ─

/** True when the action string looks like a marketplace action reference (owner/repo@version). */
function isActionRef(action: string): boolean {
  return /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+@/.test(action);
}

/**
 * Replace the version tag in an action ref if the org index has a pinned version,
 * otherwise return the ref as-is.
 */
function pinnedVersion(action: string, versions: Record<string, string>): string {
  const atIdx = action.lastIndexOf('@');
  if (atIdx === -1) return action;
  const base = action.slice(0, atIdx);
  return versions[base] ? `${base}@${versions[base]}` : action;
}

/** Convert a workflow name to a valid GHA job id (kebab-case, no spaces). */
function toJobId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'build';
}

/** Minimal YAML quoting: wrap in double quotes if the value contains special chars. */
function q(value: string): string {
  if (/[:#\[\]{}&*!|>'"%@`,]/.test(value) || value.includes('\n') || value.trim() !== value) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}
