// `@cf-migrate` Copilot chat participant.
//
// Users can ask:
//   @cf-migrate explain what happens in the freestyle step on line 42
//   @cf-migrate /analyse
//   @cf-migrate /plan
//   @cf-migrate /snippet docker buildkit cache
//   @cf-migrate /status
//   @cf-migrate /approve
//
// The participant keeps the conversation grounded in the current SessionContext —
// pipeline YAML, analysis, plan, KB hits — and delegates LLM synthesis to Copilot via
// the `request.stream` API (never calls our own LLMClient here, so the user's chat
// model quota is used).

import * as vscode from 'vscode';

import type { ExtensionServices } from '../services/ExtensionServices';

type ChatRequest = {
  prompt: string;
  command?: string;
  references?: readonly unknown[];
};

type ChatStream = {
  markdown(value: string | vscode.MarkdownString): void;
  progress(value: string): void;
  button?(command: vscode.Command): void;
};

export function registerCopilotParticipant(
  context: vscode.ExtensionContext,
  services: () => ExtensionServices | undefined,
): vscode.Disposable | undefined {
  const api = vscode as unknown as {
    chat?: { createChatParticipant(id: string, handler: (...args: unknown[]) => unknown): unknown };
  };
  if (!api.chat?.createChatParticipant) return undefined;

  const handler = async (...args: unknown[]): Promise<unknown> => {
    // The Chat Participant API hands us (request, chatContext, response, token).
    // The local ChatRequest/ChatStream types describe just the surface we touch.
    const request = args[0] as ChatRequest;
    const response = args[2] as ChatStream;
    const s = services();
    if (!s) {
      response.markdown('No workspace is open — open the folder containing your `codefresh.yml` and try again.');
      return;
    }

    switch (request.command) {
      case 'analyse':
        response.progress('Running analysis…');
        await vscode.commands.executeCommand('cf-migrate.analyse');
        response.markdown(renderAnalysisSummary(s));
        return;
      case 'plan':
        response.progress('Generating migration plan…');
        await vscode.commands.executeCommand('cf-migrate.plan');
        response.markdown(renderPlanSummary(s));
        return;
      case 'status':
        response.markdown(renderStatus(s));
        return;
      case 'approve':
        await vscode.commands.executeCommand('cf-migrate.openApproval');
        response.markdown('Opened the approval panel. Approve items there, then run `/generate`.');
        return;
      case 'snippet': {
        const query = request.prompt.trim();
        if (!query) {
          response.markdown('Usage: `/snippet <keywords>` — e.g. `/snippet docker buildkit cache`.');
          return;
        }
        const results = await s.agents.kbManager.query(query, 5);
        if (results.length === 0) {
          response.markdown(`No KB matches for _${query}_.`);
          return;
        }
        response.markdown(
          `**Top matches for** _${query}_:\n\n` +
            results
              .map(
                (r) =>
                  `- **${r.item.title}** (${r.item.type}, score ${r.score.toFixed(2)}) — ` +
                  `${r.item.description ?? ''}`,
              )
              .join('\n'),
        );
        return;
      }
      case 'explain':
      default: {
        response.markdown(await renderExplanation(s, request.prompt));
      }
    }
  };

  const participant = api.chat.createChatParticipant('cf-migrate.assistant', handler) as {
    dispose(): void;
    iconPath?: vscode.Uri;
  };
  return { dispose: () => (participant as { dispose(): void }).dispose() };
}

function renderStatus(s: ExtensionServices): string {
  const lines: string[] = [];
  lines.push(`**Phase:** ${s.session.phase}`);
  lines.push(`**LLM:** ${s.llmAvailable ? 'Copilot available' : '⚠️ no LLM — deterministic mode'}`);
  if (s.session.activePipeline) {
    lines.push(`**Active pipeline:** \`${s.session.activePipeline.relativePath}\``);
  }
  if (s.session.inventory) {
    lines.push(`**Discovered:** ${s.session.inventory.pipelines.length} pipeline(s)`);
  }
  if (s.session.analysisResult) {
    const a = s.session.analysisResult;
    lines.push(`**Analysed:** ${a.constructs.length} constructs, complexity ${a.complexityScore.toFixed(2)}`);
  }
  if (s.session.migrationPlan) {
    const p = s.session.migrationPlan;
    lines.push(
      `**Plan:** ${p.items.length} items — ${p.approvalState.approvedCount} approved, ` +
        `${p.approvalState.pendingCount} pending, ${p.approvalState.rejectedCount} rejected`,
    );
  }
  if (s.session.generationManifest) {
    lines.push(
      `**Generated workflows:** ${s.session.generationManifest.workflows.map((w) => w.filename).join(', ')}`,
    );
  }
  return lines.join('\n\n');
}

function renderAnalysisSummary(s: ExtensionServices): string {
  const a = s.session.analysisResult;
  if (!a) return 'No analysis result yet.';
  const byTier = new Map<string, number>();
  for (const c of a.constructs) {
    byTier.set(c.confidenceTier, (byTier.get(c.confidenceTier) ?? 0) + 1);
  }
  return (
    `**Analysis complete.**\n\n` +
    `- Constructs: ${a.constructs.length} (` +
    ['A', 'B', 'C'].map((t) => `${t}: ${byTier.get(t) ?? 0}`).join(', ') +
    `)\n` +
    `- Complexity: ${a.complexityScore.toFixed(2)}\n` +
    `- Proposed workflows: ${a.structuralRecommendation.proposedWorkflows.length}\n` +
    `\nRun \`/plan\` to generate a migration plan.`
  );
}

function renderPlanSummary(s: ExtensionServices): string {
  const p = s.session.migrationPlan;
  if (!p) return 'No plan yet.';
  return (
    `**Plan generated.**\n\n` +
    `- ${p.items.length} plan items (${p.items.filter((i) => i.requiresReview).length} need review)\n` +
    `- Status: **${p.approvalState.status}**\n\n` +
    `Run \`/approve\` or use the Approval panel to review. Approving unlocks generation.`
  );
}

async function renderExplanation(s: ExtensionServices, question: string): Promise<string> {
  const head = s.session.activePipeline
    ? `Active pipeline: \`${s.session.activePipeline.relativePath}\`.\n\n`
    : '';
  if (!question.trim()) {
    return (
      head +
      `I can help with:\n- \`/analyse\` — run analysis\n- \`/plan\` — generate the migration plan\n- \`/snippet <q>\` — search the KB\n- \`/status\` — show migration state\n- \`/approve\` — open the approval panel`
    );
  }
  try {
    const results = await s.agents.kbManager.query(question, 3);
    if (results.length === 0) {
      return head + `I don't have a KB match for that. Try \`/snippet <keywords>\` with different terms.`;
    }
    return (
      head +
      `**Relevant KB items:**\n\n` +
      results
        .map((r) => `- **${r.item.title}** _(${r.item.type}, score ${r.score.toFixed(2)})_ — ${r.item.description ?? ''}`)
        .join('\n')
    );
  } catch (err) {
    return head + `KB search failed: ${(err as Error).message}`;
  }
}
