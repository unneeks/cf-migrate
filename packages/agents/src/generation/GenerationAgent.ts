// SPEC §5.4 — Generation phase.
//
// The GenerationAgent turns an approved MigrationPlan into one or more GHA workflow
// YAML files. It STRICTLY enforces the approval gate — calling `generate()` on a plan
// whose `approvalState.status` is not 'approved' throws ApprovalRequiredError.
//
// Strategy:
//   • Group PlanItems by `targetWorkflow` filename.
//   • For each workflow: resolve KB snippets via the SnippetRenderer, then ask the LLM
//     to assemble the per-workflow snippets + CF context into a final YAML.
//   • Concatenate resolved snippets as reference material; the LLM is instructed to
//     reuse them verbatim wherever they fit.
//   • Output is captured as a GeneratedWorkflow record; validation runs as a separate
//     pass (ValidationAgent).

import {
  AnalysisResult,
  ApprovalRequiredError,
  GeneratedWorkflow,
  GenerationManifest,
  KBItem,
  LedgerWriter,
  MigrationPlan,
  OrgSettings,
  OrgWorkflowIndex,
  PipelineFile,
  PlanItem,
  uuid,
} from '@cf-migrate/core';

import {
  LLMClient,
  PromptRenderer,
} from '@cf-migrate/llm';
import { SnippetRenderer, type FileKBStore, type KBSearch } from '@cf-migrate/kb';

export interface GenerationAgentOptions {
  llm: LLMClient;
  ledger?: LedgerWriter;
  promptRenderer: PromptRenderer;
  kbStore: FileKBStore;
  kbSearch?: KBSearch;
  orgSettings: OrgSettings;
  orgIndex: OrgWorkflowIndex;
  snippetRenderer?: SnippetRenderer;
}

interface WorkflowBucket {
  filename: string;
  items: PlanItem[];
}

export class GenerationAgent {
  private readonly llm: LLMClient;
  private readonly ledger?: LedgerWriter;
  private readonly prompts: PromptRenderer;
  private readonly kbStore: FileKBStore;
  private readonly orgSettings: OrgSettings;
  private readonly orgIndex: OrgWorkflowIndex;
  private readonly renderer: SnippetRenderer;

  constructor(opts: GenerationAgentOptions) {
    this.llm = opts.llm;
    this.ledger = opts.ledger;
    this.prompts = opts.promptRenderer;
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
      // ApprovalRequiredError is constructed without args by design — the canonical
      // message is set inside the class. Surface plan context via the ledger instead.
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
      const resolvedSnippets: Array<{ id: string; body: string; unresolved: string[] }> = [];

      for (const item of bucket.items) {
        if (!item.kbSnippetId) continue;
        let snippet: KBItem | null = null;
        try {
          snippet = await this.kbStore.get(item.kbSnippetId);
        } catch {
          snippet = null;
        }
        if (!snippet) continue;

        const rendered = this.renderer.render(snippet, {
          planItemParameters: item.ghaRecommendation.parameters,
          orgSettings: this.orgSettings,
          orgIndex: this.orgIndex,
          cfConstructValue: undefined,
        });
        resolvedSnippets.push({
          id: snippet.id,
          body: rendered.rendered,
          unresolved: rendered.unresolved,
        });
        for (const gha of snippet.ghaConstructs ?? []) actionsUsed.add(gha);
      }

      // Collect security improvements based on plan items
      for (const item of bucket.items) {
        if (item.type === 'security' && item.ghaRecommendation.actionOrPattern.includes('OIDC')) {
          securityImprovements.push(`OIDC federation for ${item.cfConstructRef.constructName}`);
        }
      }

      const { systemPrompt, userMessage } = await this.prompts.render('generation', {
        WORKFLOW_FILENAME: bucket.filename,
        CF_PIPELINE_PATH: pipeline.relativePath,
        CF_YAML: pipeline.rawYaml,
        PLAN_ITEMS: JSON.stringify(
          bucket.items.map((i) => ({
            type: i.type,
            cfConstruct: i.cfConstructRef,
            gha: i.ghaRecommendation,
            rationale: i.rationale,
            requiresReview: i.requiresReview,
          })),
          null,
          2,
        ),
        RESOLVED_SNIPPETS: resolvedSnippets.length
          ? resolvedSnippets
              .map((s) => `### ${s.id}\n\n\`\`\`yaml\n${s.body}\n\`\`\`${s.unresolved.length ? `\n\nUnresolved: ${s.unresolved.join(', ')}` : ''}`)
              .join('\n\n')
          : '(no pre-rendered snippets)',
        ORG_RUNNERS: JSON.stringify(this.orgIndex.runnerCatalog ?? [], null, 2),
        ORG_ACTION_VERSIONS: JSON.stringify(this.orgIndex.actionVersions ?? {}, null, 2),
        TRIGGER_SUMMARY: JSON.stringify(analysis.triggerInventory, null, 2),
      });

      const response = await this.llm.complete({
        model: 'copilot',
        systemPrompt,
        userMessage,
        temperature: 0.1,
        maxTokens: 8000,
        jsonMode: false,
      });

      const yaml = extractYaml(response.content);

      const workflow: GeneratedWorkflow = {
        workflowName: bucket.filename.replace(/\.ya?ml$/i, ''),
        filename: bucket.filename,
        yamlContent: yaml,
        sourceItems: bucket.items.map((i) => i.id),
        usedKbItems: resolvedSnippets.map((s) => s.id),
        generatedAt: new Date(),
      };
      workflows.push(workflow);

      await this.ledger?.append(
        'file.written',
        {
          filename: bucket.filename,
          itemCount: bucket.items.length,
          snippetCount: resolvedSnippets.length,
          model: response.model,
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

/** Pull the YAML out of a markdown code fence if the LLM wrapped it; else use as-is. */
function extractYaml(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:ya?ml)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim() + '\n';
  return trimmed.endsWith('\n') ? trimmed : trimmed + '\n';
}
