// SPEC §5.2 — Analysis phase.
//
// The AnalysisAgent runs two passes:
//   (1) Deterministic: runs all 18 detectors, builds the data-flow graph, and extracts
//       topology summaries (docker build chains, deploy targets, secrets, plugins,
//       triggers). This pass is fully offline and produces concrete facts.
//   (2) LLM (optional): feeds the deterministic summary to the LLM and asks only the
//       "judgment" questions — workflow split, intent, non-obvious observations. The
//       LLM output is schema-validated; if the LLM is unavailable the analysis still
//       completes with a deterministic-only structural recommendation.

import {
  AnalysisResult,
  DetectedConstruct,
  DeployTarget,
  DockerBuildChain,
  LedgerWriter,
  ParallelismGroup,
  PipelineFile,
  PluginRef,
  SecretRef,
  StructuralRecommendation,
  TriggerDef,
  parseYaml,
  uuid,
} from '@cf-migrate/core';

import { detectAllConstructs } from '../detectors/ConstructDetectors';
import { DataFlowGraphBuilder } from './DataFlowGraphBuilder';

import { LLMClient, callWithRetry, AnalysisResultLLMSchema, PromptRenderer } from '@cf-migrate/llm';

export interface AnalysisAgentOptions {
  llm?: LLMClient;
  ledger?: LedgerWriter;
  promptRenderer?: PromptRenderer;
  /** Skip the LLM pass entirely (deterministic only). */
  deterministicOnly?: boolean;
}

export class AnalysisAgent {
  private readonly llm?: LLMClient;
  private readonly ledger?: LedgerWriter;
  private readonly prompts?: PromptRenderer;
  private readonly deterministicOnly: boolean;
  private readonly dataFlow = new DataFlowGraphBuilder();

  constructor(opts: AnalysisAgentOptions = {}) {
    this.llm = opts.llm;
    this.ledger = opts.ledger;
    this.prompts = opts.promptRenderer;
    this.deterministicOnly = opts.deterministicOnly ?? false;
  }

  async analyse(pipeline: PipelineFile): Promise<AnalysisResult> {
    const started = Date.now();

    const constructs = detectAllConstructs({
      filePath: pipeline.path,
      source: pipeline.rawYaml,
    });

    const dataFlowGraph = this.dataFlow.build({
      pipelinePath: pipeline.path,
      rawYaml: pipeline.rawYaml,
      constructs,
    });

    const parallelismGroups = extractParallelismGroups(constructs);
    const dockerTopology = extractDockerTopology(constructs);
    const deployTopology = extractDeployTopology(constructs);
    const secretsInventory = extractSecretsInventory(constructs, pipeline.rawYaml);
    const pluginInventory = extractPluginInventory(constructs);
    const triggerInventory = extractTriggerInventory(constructs, pipeline.rawYaml);

    const deterministicScore = computeComplexityScore(constructs);

    // Fallback structural recommendation — pre-LLM.
    let structuralRecommendation: StructuralRecommendation = fallbackStructural(pipeline, constructs);
    let complexityScore = deterministicScore;
    let llmNotes: string[] | undefined;

    // Run LLM for judgment calls if available.
    const canUseLlm =
      !this.deterministicOnly && this.llm && this.prompts && (await this.llm.isAvailable().catch(() => false));

    if (canUseLlm && this.llm && this.prompts) {
      try {
        const { systemPrompt, userMessage } = await this.prompts.render('analysis', {
          PIPELINE_PATH: pipeline.relativePath,
          PIPELINE_NAME: pipeline.name,
          PIPELINE_YAML: pipeline.rawYaml,
          DETECTED_CONSTRUCTS_SUMMARY: summariseConstructs(constructs),
          DATA_FLOW_SUMMARY: summariseDataFlow(dataFlowGraph),
          DOCKER_SUMMARY: JSON.stringify(dockerTopology, null, 2),
          DEPLOY_SUMMARY: JSON.stringify(deployTopology, null, 2),
          SECRETS_SUMMARY: JSON.stringify(
            secretsInventory.map((s) => ({ name: s.name, classification: s.classification })),
            null,
            2,
          ),
          PLUGIN_SUMMARY: JSON.stringify(pluginInventory, null, 2),
        });

        const result = await callWithRetry({
          client: this.llm,
          request: {
            model: 'copilot',
            systemPrompt,
            userMessage,
            temperature: 0.2,
            maxTokens: 4096,
            jsonMode: true,
          },
          schema: AnalysisResultLLMSchema,
          ledger: this.ledger,
          phase: 'analysis',
        });

        structuralRecommendation = {
          rationale: result.rationale,
          proposedWorkflows: result.proposedWorkflows.map((w) => ({
            name: w.name,
            filename: w.filename,
            cfSourceSteps: w.cfSourceSteps,
            trigger: w.trigger,
            estimatedJobCount: w.estimatedJobCount ?? 1,
          })),
          crossCuttingConcerns: result.crossCuttingConcerns ?? [],
        };
        complexityScore = Math.max(deterministicScore, result.complexityScore);
        llmNotes = result.nonObviousObservations;
      } catch (err) {
        await this.ledger?.append(
          'error',
          { phase: 'analysis', error: (err as Error).message },
          { pipelinePath: pipeline.relativePath },
        );
        // fall back to deterministic recommendation
      }
    }

    const result: AnalysisResult = {
      id: uuid(),
      pipelinePath: pipeline.path,
      analysedAt: new Date(),
      constructs,
      dataFlowGraph,
      parallelismGroups,
      dockerTopology,
      deployTopology,
      secretsInventory,
      pluginInventory,
      triggerInventory,
      structuralRecommendation,
      complexityScore,
      estimatedWorkflowCount: structuralRecommendation.proposedWorkflows.length,
      proposedWorkflowNames: structuralRecommendation.proposedWorkflows.map((w) => w.name),
      llmNotes,
    };

    await this.ledger?.append(
      'analysis.completed',
      {
        constructCount: constructs.length,
        complexityScore,
        durationMs: Date.now() - started,
        analysisId: result.id,
      },
      { pipelinePath: pipeline.relativePath },
    );

    return result;
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// Deterministic summarisers

function computeComplexityScore(constructs: DetectedConstruct[]): number {
  // Weighted by tier: C=0.3, B=0.15, A=0.05 per occurrence; clamped [0,1].
  let score = 0;
  for (const c of constructs) {
    if (c.confidenceTier === 'C') score += 0.3;
    else if (c.confidenceTier === 'B') score += 0.15;
    else score += 0.05;
  }
  return Math.min(1, score / 3);
}

function extractParallelismGroups(constructs: DetectedConstruct[]): ParallelismGroup[] {
  const out: ParallelismGroup[] = [];
  for (const c of constructs.filter((x) => x.type === 'step.parallel')) {
    const raw = c.rawValue as { steps?: Record<string, { image?: string }> };
    const inner = raw?.steps ? Object.keys(raw.steps) : [];
    const images = new Set(
      Object.values(raw?.steps ?? {})
        .map((s) => (s && typeof s === 'object' ? (s as { image?: string }).image : undefined))
        .filter((x): x is string => typeof x === 'string'),
    );
    out.push({
      steps: inner,
      isTrue: images.size > 0 && images.size <= 1, // single image → homogeneous → matrix-friendly
      sharedState: constructs.some((x) => x.type === 'volumes.shared' || x.type === 'cf_export'),
    });
  }
  return out;
}

function extractDockerTopology(constructs: DetectedConstruct[]): DockerBuildChain[] {
  const builds = constructs.filter((c) => c.type === 'step.build');
  const pushes = constructs.filter((c) => c.type === 'step.push');
  const out: DockerBuildChain[] = [];

  for (const b of builds) {
    const raw = b.rawValue as {
      image_name?: string;
      tag?: string;
      registry?: string;
      platform?: string;
      build_arguments?: unknown;
      cache_from?: unknown;
    };
    const imageName = raw?.image_name ?? b.stepName ?? '';
    const matchingPush = pushes.find((p) => {
      const pr = p.rawValue as { candidate?: string; image_name?: string };
      return pr?.candidate?.includes(b.stepName ?? '') || pr?.image_name === imageName;
    });
    out.push({
      buildStep: b.stepName ?? '',
      pushStep: matchingPush?.stepName,
      imageName,
      registryType: classifyRegistry(
        (matchingPush?.rawValue as { registry?: string })?.registry ?? raw?.registry,
      ),
      multiPlatform: typeof raw?.platform === 'string' && raw.platform.includes(','),
      cacheStrategy: raw?.cache_from ? 'layer' : 'none',
    });
  }
  return out;
}

function classifyRegistry(r?: string): DockerBuildChain['registryType'] {
  if (!r) return 'custom';
  const x = r.toLowerCase();
  if (x.includes('ecr') || x.includes('amazonaws')) return 'ecr';
  if (x.includes('gcr') || x.includes('pkg.dev')) return 'gcr';
  if (x.includes('ghcr')) return 'ghcr';
  if (x.includes('docker.io') || x === 'dockerhub') return 'dockerhub';
  return 'custom';
}

function extractDeployTopology(constructs: DetectedConstruct[]): DeployTarget[] {
  const out: DeployTarget[] = [];
  for (const c of constructs.filter((x) => x.type === 'step.deploy')) {
    const raw = c.rawValue as { image?: string; commands?: string[]; environment?: unknown };
    const image = raw?.image ?? '';
    const commands = Array.isArray(raw?.commands) ? raw.commands.join('\n') : '';
    const envName = detectEnvNameFromCommands(commands) ?? detectEnvFromStepName(c.stepName ?? '');
    out.push({
      stepName: c.stepName ?? '',
      environment: envName ?? 'unknown',
      method: /helm\b/.test(image + commands) ? 'helm' : /kubectl/.test(image + commands) ? 'kubectl' : 'custom',
      hasApprovalPolicy: /manual|approval/i.test(c.stepName ?? ''),
      hasRollbackStrategy: /rollback|helm.*upgrade.*--atomic/i.test(commands),
    });
  }
  return out;
}

function detectEnvNameFromCommands(cmds: string): string | undefined {
  const m = cmds.match(/--namespace[\s=]+([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  const m2 = cmds.match(/\b(dev|staging|stage|qa|prod|production)\b/);
  if (m2) return m2[1];
  return undefined;
}

function detectEnvFromStepName(name: string): string | undefined {
  const m = name.match(/\b(dev|staging|stage|qa|prod|production)\b/i);
  return m?.[1];
}

function extractSecretsInventory(constructs: DetectedConstruct[], raw: string): SecretRef[] {
  const out = new Map<string, SecretRef>();
  const patterns: Array<{ re: RegExp; classification: SecretRef['classification'] }> = [
    { re: /\bAWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)\b/, classification: 'cloud-credential' },
    { re: /\bGCLOUD_SA_JSON\b|\bGOOGLE_APPLICATION_CREDENTIALS\b/, classification: 'cloud-credential' },
    { re: /\bAZURE_CREDENTIALS\b/, classification: 'cloud-credential' },
    { re: /\bDOCKER_PASSWORD\b|\bREGISTRY_PASSWORD\b/, classification: 'registry-credential' },
    { re: /\bNPM_TOKEN\b|\bGH_TOKEN\b|\bGITHUB_TOKEN\b/, classification: 'api-key' },
    { re: /\bSLACK_WEBHOOK\b|\bSLACK_TOKEN\b/, classification: 'api-key' },
    { re: /\bKUBECONFIG\b/, classification: 'cloud-credential' },
  ];
  for (const line of raw.split('\n')) {
    for (const p of patterns) {
      const m = line.match(p.re);
      if (m) {
        const name = m[0];
        if (!out.has(name)) {
          out.set(name, {
            name,
            classification: p.classification,
            source: line.includes('${{') ? 'env' : 'inline',
            sensitivity: p.classification === 'cloud-credential' ? 'high' : 'medium',
          });
        }
      }
    }
  }
  // Contexts carried in constructs — classify as cloud-credential by default.
  const contextConstructs = constructs.filter((c) => c.type === 'spec.contexts');
  for (const c of contextConstructs) {
    if (Array.isArray(c.rawValue)) {
      for (const name of c.rawValue as unknown[]) {
        if (typeof name !== 'string' || out.has(name)) continue;
        out.set(name, {
          name,
          classification: guessContextClass(name),
          source: 'context',
          sensitivity: 'high',
        });
      }
    }
  }
  return [...out.values()];
}

function guessContextClass(name: string): SecretRef['classification'] {
  const n = name.toLowerCase();
  if (n.includes('aws') || n.includes('gcp') || n.includes('azure') || n.includes('kube')) return 'cloud-credential';
  if (n.includes('registry') || n.includes('docker') || n.includes('ecr') || n.includes('gcr') || n.includes('ghcr'))
    return 'registry-credential';
  if (n.includes('token') || n.includes('api') || n.includes('slack')) return 'api-key';
  return 'unknown';
}

function extractPluginInventory(constructs: DetectedConstruct[]): PluginRef[] {
  const out: PluginRef[] = [];
  for (const c of constructs.filter((x) => x.type === 'plugin')) {
    const raw = c.rawValue as { image?: string; type?: string; inputs?: Record<string, unknown> };
    const name = raw?.image ?? raw?.type ?? c.stepName ?? 'unknown';
    const version = (raw?.image ?? '').split(':')[1];
    out.push({
      pluginName: name,
      version,
      inputs: raw?.inputs ?? {},
      outputs: [],
      marketplaceEquivalent: suggestMarketplaceEquivalent(name),
      requiresCompositeAction: !suggestMarketplaceEquivalent(name),
    });
  }
  return out;
}

function suggestMarketplaceEquivalent(name: string): string | undefined {
  const n = name.toLowerCase();
  if (n.includes('slack')) return 'slackapi/slack-github-action@v1';
  if (n.includes('jira')) return 'atlassian/gajira-create@v3';
  if (n.includes('docker') || n.includes('buildx')) return 'docker/build-push-action@v5';
  if (n.includes('helm')) return 'azure/setup-helm@v4';
  if (n.includes('kubectl') || n.includes('k8s')) return 'azure/k8s-set-context@v4';
  return undefined;
}

function extractTriggerInventory(constructs: DetectedConstruct[], raw: string): TriggerDef[] {
  const out: TriggerDef[] = [];
  if (/\$\{\{\s*CF_PULL_REQUEST\b/.test(raw)) out.push({ type: 'pull_request' });
  if (/\$\{\{\s*CF_BRANCH\b/.test(raw) || /branch\s*:\s*(only|ignore)/.test(raw)) {
    out.push({ type: 'push' });
  }
  if (/cron/i.test(raw)) out.push({ type: 'schedule', cronExpression: 'UNKNOWN' });
  if (/\bmanual\s*:\s*true\b/.test(raw)) out.push({ type: 'manual' });
  if (out.length === 0 && constructs.some((c) => c.type === 'triggers')) {
    out.push({ type: 'push' });
  }
  return out;
}

function summariseConstructs(constructs: DetectedConstruct[]): string {
  const counts = new Map<string, number>();
  for (const c of constructs) counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
  return (
    [...counts.entries()]
      .sort()
      .map(([t, n]) => `  - ${t}: ${n}`)
      .join('\n') || '  (none)'
  );
}

function summariseDataFlow(edges: import('@cf-migrate/core').DataFlowEdge[]): string {
  if (edges.length === 0) return '  (no data-flow edges)';
  return edges
    .slice(0, 20)
    .map((e) => `  - ${e.producerStep} --(${e.dataType}:${e.key})--> ${e.consumerStep}`)
    .join('\n') + (edges.length > 20 ? `\n  (+${edges.length - 20} more)` : '');
}

function fallbackStructural(pipeline: PipelineFile, constructs: DetectedConstruct[]): StructuralRecommendation {
  // No-LLM fallback: one workflow per pipeline, pulling every detected step in.
  const stepNames = uniqueStepNames(pipeline.rawYaml);
  const filename = sanitizeWorkflowFilename(pipeline.name);
  return {
    rationale:
      'Deterministic fallback: one workflow per CF pipeline. Structural re-grouping was skipped because the LLM was not available.',
    proposedWorkflows: [
      {
        name: pipeline.name.replace(/\.ya?ml$/i, ''),
        filename,
        cfSourceSteps: stepNames,
        trigger: ['push'],
        estimatedJobCount: Math.max(1, Math.ceil(stepNames.length / 4)),
      },
    ],
    crossCuttingConcerns: constructs
      .filter((c) => c.confidenceTier === 'C')
      .map((c) => `${c.type}${c.stepName ? ` (${c.stepName})` : ''} requires restructuring`),
  };
}

function uniqueStepNames(raw: string): string[] {
  try {
    const parsed = parseYaml<{ steps?: Record<string, unknown> }>(raw);
    if (!parsed?.steps || typeof parsed.steps !== 'object') return [];
    return Object.keys(parsed.steps);
  } catch {
    return [];
  }
}

function sanitizeWorkflowFilename(name: string): string {
  return name
    .replace(/\.ya?ml$/i, '')
    .replace(/[^a-z0-9_-]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase() + '.yml';
}
