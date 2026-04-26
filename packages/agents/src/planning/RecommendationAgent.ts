// SPEC §5.3.d — Advisory recommendations.
//
// Surfaces cross-cutting suggestions that are independent of any single PlanItem:
//   • OIDC migration opportunities (static cloud creds → OIDC)
//   • Version pinning of actions per org policy
//   • Reusable workflow candidates (duplicated jobs across pipelines)
//   • Plugin gaps (no marketplace equivalent → composite action)
//   • Runner optimisation (GH-hosted vs self-hosted)

import {
  AnalysisResult,
  LedgerWriter,
  MigrationPlan,
  OrgWorkflowIndex,
  Recommendation,
  uuid,
} from '@cf-migrate/core';

import {
  LLMClient,
  PromptRenderer,
  RecommendationArraySchema,
  callWithRetry,
} from '@cf-migrate/llm';

export interface RecommendationAgentOptions {
  llm?: LLMClient;
  ledger?: LedgerWriter;
  promptRenderer?: PromptRenderer;
  ghaIndex?: OrgWorkflowIndex;
  deterministicOnly?: boolean;
}

export class RecommendationAgent {
  private readonly llm?: LLMClient;
  private readonly ledger?: LedgerWriter;
  private readonly prompts?: PromptRenderer;
  private readonly ghaIndex?: OrgWorkflowIndex;
  private readonly deterministicOnly: boolean;

  constructor(opts: RecommendationAgentOptions = {}) {
    this.llm = opts.llm;
    this.ledger = opts.ledger;
    this.prompts = opts.promptRenderer;
    this.ghaIndex = opts.ghaIndex;
    this.deterministicOnly = opts.deterministicOnly ?? false;
  }

  async recommend(analysis: AnalysisResult, plan: MigrationPlan): Promise<Recommendation[]> {
    const deterministic: Recommendation[] = [];

    // OIDC migration: any cloud-credential secret that could come from OIDC instead.
    for (const s of analysis.secretsInventory) {
      if (s.classification === 'cloud-credential') {
        deterministic.push({
          id: uuid(),
          type: 'security-oidc',
          title: `Replace ${s.name} with OIDC federation`,
          description:
            `${s.name} is a long-lived cloud credential. GitHub Actions can federate to AWS/GCP/Azure ` +
            'via OIDC, issuing per-run short-lived tokens instead. Update the workflow permissions to ' +
            '`id-token: write` and configure a workload identity pool / IAM role.',
          severity: 'warning',
          actionable: true,
        });
      }
    }

    // Action pinning per org convention
    if (this.ghaIndex) {
      const knownActions = Object.keys(this.ghaIndex.actionVersions ?? {});
      if (knownActions.length > 0) {
        deterministic.push({
          id: uuid(),
          type: 'action-version',
          title: 'Pin actions to org-standard versions',
          description:
            `${knownActions.length} action(s) are standardized across the org. The generator will pin to ` +
            'these versions automatically. Override per plan item if a newer version is intentional.',
          severity: 'info',
          actionable: false,
        });
      }

      // Reusable workflow candidates — match on the workflow's name (semantic anchor)
      // since ReusableWorkflowRef exposes filePath + name, not a free-form purpose.
      for (const rw of this.ghaIndex.reusableWorkflows ?? []) {
        const needle = rw.name.toLowerCase();
        if (
          plan.items.some(
            (i) =>
              i.ghaRecommendation.description.toLowerCase().includes(needle) ||
              i.ghaRecommendation.actionOrPattern.toLowerCase().includes(needle),
          )
        ) {
          deterministic.push({
            id: uuid(),
            type: 'reusable-workflow-exists',
            title: `Consider calling reusable workflow: ${rw.filePath}`,
            description: `The org already has a reusable workflow named "${rw.name}" at ${rw.filePath}. Using it avoids re-implementing the same logic.`,
            severity: 'suggestion',
            actionable: true,
          });
        }
      }
    }

    // Plugin gaps
    for (const p of analysis.pluginInventory) {
      if (p.requiresCompositeAction) {
        deterministic.push({
          id: uuid(),
          type: 'plugin-gap',
          title: `No marketplace equivalent for CF plugin: ${p.pluginName}`,
          description:
            `Plugin "${p.pluginName}" has no direct GitHub Actions marketplace equivalent. ` +
            'Wrap it in a composite action or inline its logic as a run step.',
          severity: 'warning',
          actionable: true,
        });
      }
    }

    // LLM pass for judgment-heavy recommendations
    const canUseLlm =
      !this.deterministicOnly && this.llm && this.prompts && (await this.llm.isAvailable().catch(() => false));

    if (canUseLlm && this.llm && this.prompts) {
      try {
        const { systemPrompt, userMessage } = await this.prompts.render('recommendation', {
          PIPELINE_PATH: analysis.pipelinePath,
          PLAN_SUMMARY: summarisePlan(plan),
          ANALYSIS_SUMMARY: summariseAnalysis(analysis),
          DETERMINISTIC_RECOMMENDATIONS: JSON.stringify(
            deterministic.map((d) => ({ type: d.type, title: d.title })),
            null,
            2,
          ),
          ORG_INDEX: this.ghaIndex ? JSON.stringify(this.ghaIndex, null, 2).slice(0, 4000) : '(no org index)',
        });

        const { recommendations } = await callWithRetry({
          client: this.llm,
          request: {
            model: 'copilot',
            systemPrompt,
            userMessage,
            temperature: 0.3,
            maxTokens: 3000,
            jsonMode: true,
          },
          schema: RecommendationArraySchema,
          ledger: this.ledger,
          phase: 'recommendation',
        });

        for (const r of recommendations ?? []) {
          deterministic.push({
            id: uuid(),
            type: r.type,
            title: r.title,
            description: r.description,
            severity: r.severity,
            actionable: r.actionable,
          });
        }
      } catch (err) {
        await this.ledger?.append(
          'error',
          { phase: 'recommendation', error: (err as Error).message },
          { pipelinePath: analysis.pipelinePath },
        );
      }
    }

    // Recommendations piggyback on plan.generated payload — emit a diagnostic log only.
    return deterministic;
  }
}

function summarisePlan(plan: MigrationPlan): string {
  const byType = new Map<string, number>();
  for (const it of plan.items) {
    byType.set(it.type, (byType.get(it.type) ?? 0) + 1);
  }
  const requiresReview = plan.items.filter((i) => i.requiresReview).length;
  return (
    `Plan ID ${plan.id}: ${plan.items.length} items, ${requiresReview} require review.\n` +
    [...byType.entries()].map(([t, n]) => `  - ${t}: ${n}`).join('\n')
  );
}

function summariseAnalysis(a: AnalysisResult): string {
  return `Complexity ${a.complexityScore.toFixed(2)}, ${a.estimatedWorkflowCount} proposed workflow(s).`;
}
