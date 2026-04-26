// SPEC §5.3 — Planning phase.
//
// The PlanningAgent turns an AnalysisResult into a MigrationPlan (array of PlanItems).
// It runs in three passes:
//   (1) Tier A: direct lookup for deterministic constructs (no LLM).
//   (2) Tier B/C: batch LLM call for constructs needing judgment (e.g. docker build,
//       parallel → matrix-vs-sibling, volumes.shared decomposition).
//   (3) Enrichment: attach KB snippet candidates via LexicalSearch; assign a target
//       workflow from the structural recommendation; set `requiresReview` for
//       C-tier items or confidence<0.7.
//
// The output is an approval-state `pending` plan — it does NOT generate workflows.

import {
  AnalysisResult,
  ConfidenceTier,
  DetectedConstruct,
  LedgerWriter,
  MigrationPlan,
  PipelineFile,
  PlanItem,
  uuid,
} from '@cf-migrate/core';

import {
  LLMClient,
  PromptRenderer,
  callWithRetry,
  PlanItemArraySchema,
  type PlanItemLLM,
} from '@cf-migrate/llm';
import type { KBSearch } from '@cf-migrate/kb';

import { tierALookup, isTierA } from './TierALookup';

export interface PlanningAgentOptions {
  llm?: LLMClient;
  ledger?: LedgerWriter;
  promptRenderer?: PromptRenderer;
  kbSearch?: KBSearch;
  deterministicOnly?: boolean;
}

export class PlanningAgent {
  private readonly llm?: LLMClient;
  private readonly ledger?: LedgerWriter;
  private readonly prompts?: PromptRenderer;
  private readonly kbSearch?: KBSearch;
  private readonly deterministicOnly: boolean;

  constructor(opts: PlanningAgentOptions = {}) {
    this.llm = opts.llm;
    this.ledger = opts.ledger;
    this.prompts = opts.promptRenderer;
    this.kbSearch = opts.kbSearch;
    this.deterministicOnly = opts.deterministicOnly ?? false;
  }

  async plan(pipeline: PipelineFile, analysis: AnalysisResult): Promise<MigrationPlan> {
    const started = Date.now();

    // Assign a workflow per proposed structural block.
    const workflowByStep = assignWorkflowsToSteps(analysis);
    const items: PlanItem[] = [];

    // ── Tier A pass ────────────────────────────────────────────────────────────
    const remaining: DetectedConstruct[] = [];
    for (const c of analysis.constructs) {
      if (isTierA(c.type)) {
        const t = tierALookup(c);
        if (t) {
          items.push(await this.buildItem(c, t, workflowByStep, 'A'));
          continue;
        }
      }
      remaining.push(c);
    }

    // ── Tier B/C pass (LLM) ────────────────────────────────────────────────────
    const canUseLlm =
      !this.deterministicOnly && this.llm && this.prompts && (await this.llm.isAvailable().catch(() => false));

    if (remaining.length > 0 && canUseLlm && this.llm && this.prompts) {
      try {
        const { systemPrompt, userMessage } = await this.prompts.render('planning', {
          PIPELINE_PATH: pipeline.relativePath,
          ANALYSIS_SUMMARY: summariseAnalysisForPlanning(analysis),
          PROPOSED_WORKFLOWS: JSON.stringify(analysis.structuralRecommendation.proposedWorkflows, null, 2),
          REMAINING_CONSTRUCTS: JSON.stringify(
            remaining.map((c) => ({
              type: c.type,
              stepName: c.stepName,
              lineStart: c.lineStart,
              raw: summariseRaw(c.rawValue),
            })),
            null,
            2,
          ),
          DATA_FLOW: summariseFlowForPlan(analysis.dataFlowGraph),
          KB_HINTS: await this.kbHintsFor(remaining),
        });

        const { items: llmItems } = await callWithRetry({
          client: this.llm,
          request: {
            model: 'copilot',
            systemPrompt,
            userMessage,
            temperature: 0.2,
            maxTokens: 6000,
            jsonMode: true,
          },
          schema: PlanItemArraySchema,
          ledger: this.ledger,
          phase: 'planning',
        });

        for (const llmItem of llmItems) {
          const match = matchConstruct(llmItem, remaining);
          if (!match) continue;
          items.push(await this.buildItem(match, fromLLM(llmItem), workflowByStep, match.confidenceTier, llmItem));
        }

        // Deterministic fallback for constructs the LLM did not address.
        const covered = new Set(
          items.map((i) => `${i.cfConstructRef.constructType}:${i.cfConstructRef.constructName}`),
        );
        for (const c of remaining) {
          if (covered.has(`${c.type}:${c.stepName ?? ''}`)) continue;
          items.push(await this.buildItem(c, defaultMapping(c), workflowByStep, c.confidenceTier));
        }
      } catch (err) {
        await this.ledger?.append(
          'error',
          { phase: 'planning', error: (err as Error).message },
          { pipelinePath: pipeline.relativePath },
        );
        for (const c of remaining) {
          items.push(await this.buildItem(c, defaultMapping(c), workflowByStep, c.confidenceTier));
        }
      }
    } else {
      // No LLM — deterministic fallback.
      for (const c of remaining) {
        items.push(await this.buildItem(c, defaultMapping(c), workflowByStep, c.confidenceTier));
      }
    }

    // Sequence numbers in the order we produced them.
    items.forEach((it, i) => (it.sequenceNumber = i + 1));

    const plan: MigrationPlan = {
      id: uuid(),
      pipelinePath: pipeline.path,
      generatedAt: new Date(),
      generatedBy: this.deterministicOnly || !canUseLlm ? 'deterministic' : 'hybrid',
      analysisResultId: analysis.id,
      items,
      recommendations: [],
      proposedWorkflows: analysis.structuralRecommendation.proposedWorkflows,
      approvalState: {
        status: 'pending',
        approvedCount: 0,
        pendingCount: items.length,
        rejectedCount: 0,
      },
      version: 1,
    };

    await this.ledger?.append(
      'plan.generated',
      {
        itemCount: items.length,
        generatedBy: plan.generatedBy,
        durationMs: Date.now() - started,
        planId: plan.id,
      },
      { pipelinePath: pipeline.relativePath },
    );

    return plan;
  }

  private async buildItem(
    c: DetectedConstruct,
    m: ReturnType<typeof defaultMapping>,
    workflowByStep: Map<string, string>,
    tier: ConfidenceTier,
    llmSource?: PlanItemLLM,
  ): Promise<PlanItem> {
    const constructName = c.stepName ?? `${c.type}@${c.lineStart}`;
    const kbSnippetId = m.kbSnippetId ?? (await this.suggestKb(c, m));
    const requiresReview = m.requiresReview || tier === 'C' || m.confidenceScore < 0.7;
    return {
      id: uuid(),
      sequenceNumber: 0, // assigned later
      type: m.type,
      cfConstructRef: {
        filePath: c.filePath,
        lineStart: c.lineStart,
        lineEnd: c.lineEnd,
        constructType: c.type,
        constructName,
      },
      ghaRecommendation: {
        description: m.ghaDescription,
        actionOrPattern: m.ghaActionOrPattern,
        parameters: m.ghaParameters,
      },
      rationale: m.rationale,
      confidenceScore: m.confidenceScore,
      confidenceTier: tier,
      complexity: m.complexity,
      kbSnippetId,
      targetWorkflow: workflowByStep.get(constructName) ?? workflowByStep.get('*') ?? undefined,
      requiresReview,
      status: 'pending',
      ...(llmSource?.targetWorkflow ? { targetWorkflow: llmSource.targetWorkflow } : {}),
    };
  }

  private async suggestKb(c: DetectedConstruct, m: ReturnType<typeof defaultMapping>): Promise<string | undefined> {
    if (!this.kbSearch) return undefined;
    try {
      const q = `${c.type} ${m.ghaActionOrPattern}`;
      const results = await this.kbSearch.search(q, 3);
      return results[0]?.item.id;
    } catch {
      return undefined;
    }
  }

  private async kbHintsFor(constructs: DetectedConstruct[]): Promise<string> {
    if (!this.kbSearch || constructs.length === 0) return '(no KB hints)';
    const out: string[] = [];
    for (const c of constructs.slice(0, 8)) {
      try {
        const results = await this.kbSearch.search(c.type, 2);
        for (const r of results) out.push(`- ${c.type} ⇒ ${r.item.id}: ${r.item.title}`);
      } catch {
        /* ignore */
      }
    }
    return out.length ? out.join('\n') : '(no KB matches)';
  }
}

// ────────────────────────────────────────────────────────────────────────────────

function assignWorkflowsToSteps(analysis: AnalysisResult): Map<string, string> {
  const out = new Map<string, string>();
  for (const w of analysis.structuralRecommendation.proposedWorkflows) {
    for (const s of w.cfSourceSteps) out.set(s, w.filename);
    if (w.cfSourceSteps.length === 0) out.set('*', w.filename); // default mapping
  }
  if (out.size === 0) out.set('*', 'ci.yml');
  return out;
}

function matchConstruct(llm: PlanItemLLM, constructs: DetectedConstruct[]): DetectedConstruct | null {
  return (
    constructs.find((c) => c.type === llm.cfConstructType && (c.stepName ?? '') === (llm.cfStepName ?? '')) ??
    constructs.find((c) => c.type === llm.cfConstructType) ??
    null
  );
}

function fromLLM(llm: PlanItemLLM): ReturnType<typeof defaultMapping> {
  return {
    type: llm.type,
    ghaDescription: llm.ghaDescription,
    ghaActionOrPattern: llm.ghaActionOrPattern,
    // Coalesce optional schema fields back to concrete shapes the rest of the pipeline
    // expects. Zod `.optional()` on these is a transport-layer convenience for the LLM
    // (which is allowed to omit them); downstream code wants `Record<string,string>`.
    ghaParameters: llm.ghaParameters ?? {},
    rationale: llm.rationale,
    confidenceScore: llm.confidenceScore,
    complexity: llm.complexity,
    kbSnippetId: llm.kbSnippetId,
    requiresReview: llm.requiresReview,
  };
}

function defaultMapping(c: DetectedConstruct): {
  type: PlanItem['type'];
  ghaDescription: string;
  ghaActionOrPattern: string;
  ghaParameters: Record<string, string>;
  rationale: string;
  confidenceScore: number;
  complexity: PlanItem['complexity'];
  kbSnippetId?: string;
  requiresReview: boolean;
} {
  // Safety-net mapping when neither Tier A nor LLM produces a plan for a construct.
  switch (c.type) {
    case 'step.freestyle':
      return {
        type: 'construct-mapping',
        ghaDescription: 'Translate freestyle step to GHA `run:` step (with `container:` if an image is required).',
        ghaActionOrPattern: 'run',
        ghaParameters: {},
        rationale: 'Default deterministic fallback.',
        confidenceScore: 0.8,
        complexity: 'low',
        kbSnippetId: 'freestyle-to-run',
        requiresReview: false,
      };
    case 'step.build':
      return {
        type: 'docker',
        ghaDescription: 'Replace CF build with docker/build-push-action and enable BuildKit GHA cache.',
        ghaActionOrPattern: 'docker/build-push-action@v5',
        ghaParameters: { push: 'false' },
        rationale: 'Deterministic fallback; consolidates build + push.',
        confidenceScore: 0.88,
        complexity: 'low',
        kbSnippetId: 'build-push-to-action',
        requiresReview: false,
      };
    case 'step.deploy':
      return {
        type: 'deploy',
        ghaDescription: 'Deploy using a GHA Environment-gated job with OIDC credentials.',
        ghaActionOrPattern: 'environment + run',
        ghaParameters: {},
        rationale: 'Deterministic fallback; review required to pick exact deploy target.',
        confidenceScore: 0.7,
        complexity: 'medium',
        kbSnippetId: 'deploy-to-environment',
        requiresReview: true,
      };
    case 'step.composition':
      return {
        type: 'construct-mapping',
        ghaDescription: 'Translate composition to GHA service containers for integration tests.',
        ghaActionOrPattern: 'services',
        ghaParameters: {},
        rationale: 'Deterministic fallback.',
        confidenceScore: 0.6,
        complexity: 'medium',
        kbSnippetId: 'composition-to-services',
        requiresReview: true,
      };
    case 'step.parallel':
      return {
        type: 'structural',
        ghaDescription: 'Convert parallel block to matrix (homogeneous) or sibling jobs (heterogeneous).',
        ghaActionOrPattern: 'strategy.matrix',
        ghaParameters: {},
        rationale: 'Deterministic fallback — LLM should normally pick between matrix and sibling jobs.',
        confidenceScore: 0.65,
        complexity: 'medium',
        kbSnippetId: 'parallel-to-matrix',
        requiresReview: true,
      };
    case 'volumes.shared':
      return {
        type: 'structural',
        ghaDescription: 'Replace implicit shared volume with explicit upload-artifact → download-artifact pairs.',
        ghaActionOrPattern: 'actions/upload-artifact@v4',
        ghaParameters: {},
        rationale: 'Shared state must be made explicit in GHA.',
        confidenceScore: 0.6,
        complexity: 'high',
        kbSnippetId: 'shared-volume-to-artifact',
        requiresReview: true,
      };
    case 'cf_export':
      return {
        type: 'structural',
        ghaDescription: 'Replace cf_export with GITHUB_OUTPUT plus declared jobs.<id>.outputs.',
        ghaActionOrPattern: '$GITHUB_OUTPUT',
        ghaParameters: {},
        rationale: 'Variable flow must be declared at each job boundary.',
        confidenceScore: 0.72,
        complexity: 'medium',
        kbSnippetId: 'cf-export-to-output',
        requiresReview: true,
      };
    case 'step.when':
      return {
        type: 'construct-mapping',
        ghaDescription: 'Map CF when: into a GHA `if:` expression at step or job level.',
        ghaActionOrPattern: 'if',
        ghaParameters: {},
        rationale: 'Deterministic fallback; complex CF expressions need manual review.',
        confidenceScore: 0.7,
        complexity: 'medium',
        requiresReview: true,
      };
    case 'spec.contexts':
      return {
        type: 'security',
        ghaDescription: 'Replace CF contexts with GHA secrets and/or OIDC federation (preferred for cloud credentials).',
        ghaActionOrPattern: 'secrets + OIDC',
        ghaParameters: {},
        rationale: 'Secret material should be classified and migrated with care.',
        confidenceScore: 0.6,
        complexity: 'high',
        kbSnippetId: 'context-to-secrets',
        requiresReview: true,
      };
    case 'plugin':
      return {
        type: 'plugin',
        ghaDescription: 'Replace CF plugin with the nearest marketplace action (if available) or a composite action.',
        ghaActionOrPattern: 'marketplace-action',
        ghaParameters: {},
        rationale: 'Plugin parity must be verified per case.',
        confidenceScore: 0.55,
        complexity: 'high',
        requiresReview: true,
      };
    case 'pipeline.stages':
      return {
        type: 'structural',
        ghaDescription: 'Flatten stages into jobs connected by `needs:` edges.',
        ghaActionOrPattern: 'jobs + needs',
        ghaParameters: {},
        rationale: 'Stages have no direct GHA equivalent.',
        confidenceScore: 0.6,
        complexity: 'high',
        requiresReview: true,
      };
    default:
      return {
        type: 'construct-mapping',
        ghaDescription: 'No deterministic mapping available — review manually.',
        ghaActionOrPattern: 'manual',
        ghaParameters: {},
        rationale: 'Default fallback.',
        confidenceScore: 0.4,
        complexity: 'high',
        requiresReview: true,
      };
  }
}

function summariseAnalysisForPlanning(a: AnalysisResult): string {
  return [
    `Complexity score: ${a.complexityScore.toFixed(2)}`,
    `Estimated workflow count: ${a.estimatedWorkflowCount}`,
    `Structural rationale: ${a.structuralRecommendation.rationale}`,
    `Docker topology: ${a.dockerTopology.length} build chain(s)`,
    `Deploy topology: ${a.deployTopology.length} deploy target(s)`,
    `Secrets: ${a.secretsInventory.length}`,
    `Plugins: ${a.pluginInventory.length}`,
  ].join('\n');
}

function summariseFlowForPlan(edges: import('@cf-migrate/core').DataFlowEdge[]): string {
  if (edges.length === 0) return '(none)';
  return edges
    .slice(0, 20)
    .map((e) => `${e.producerStep} -[${e.dataType}:${e.key}]-> ${e.consumerStep}`)
    .join('\n');
}

function summariseRaw(v: unknown): unknown {
  try {
    const s = JSON.stringify(v);
    if (s.length > 2000) return s.slice(0, 2000) + '…';
    return v;
  } catch {
    return String(v);
  }
}
