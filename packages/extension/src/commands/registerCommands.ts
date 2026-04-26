// Registers every `cf-migrate.*` command. All commands are thin wrappers that delegate
// to agents on `services` and update the in-memory SessionContext on success.
//
// Each command wraps its work in `withProgress` so long-running LLM calls get a visible
// notification, and traps errors into a friendly `showErrorMessage` rather than letting
// them surface as unhelpful extension host errors.

import * as path from 'path';
import * as vscode from 'vscode';

import type { PipelineFile } from '@cf-migrate/core';

import { ApprovalPanel } from '../webviews/ApprovalPanel';
import type { ExtensionServices } from '../services/ExtensionServices';

export interface CommandContext {
  context: vscode.ExtensionContext;
  services: () => ExtensionServices | undefined;
  onChange: () => void;
}

export function registerCommands(cmdCtx: CommandContext): vscode.Disposable[] {
  const d: vscode.Disposable[] = [];

  d.push(
    vscode.commands.registerCommand('cf-migrate.discover', () => runDiscover(cmdCtx)),
    vscode.commands.registerCommand('cf-migrate.setActivePipeline', (rel: string) =>
      runSetActive(cmdCtx, rel),
    ),
    vscode.commands.registerCommand('cf-migrate.analyse', () => runAnalyse(cmdCtx)),
    vscode.commands.registerCommand('cf-migrate.plan', () => runPlan(cmdCtx)),
    vscode.commands.registerCommand('cf-migrate.openApproval', () => runOpenApproval(cmdCtx)),
    vscode.commands.registerCommand('cf-migrate.generate', () => runGenerate(cmdCtx)),
    vscode.commands.registerCommand('cf-migrate.validate', () => runValidate(cmdCtx)),
    vscode.commands.registerCommand('cf-migrate.openKB', () => runOpenKB(cmdCtx)),
    vscode.commands.registerCommand('cf-migrate.indexGHA', () => runIndexGHA(cmdCtx)),
    vscode.commands.registerCommand('cf-migrate.showReport', () => runShowReport(cmdCtx)),
  );

  return d;
}

// ───────────────────────────────────────────────────────────── command bodies ─

async function runDiscover(ctx: CommandContext): Promise<void> {
  const s = ctx.services();
  if (!s) return noWorkspace();
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'CF Migrate: discovering pipelines…' },
      async () => {
        const inventory = await s.agents.discovery.discover(s.workspaceFolder.uri.fsPath);
        s.session.inventory = inventory;
        s.session.phase = inventory.pipelines.length > 0 ? 'discovered' : 'idle';
        if (!s.session.activePipeline && inventory.pipelines.length > 0) {
          s.session.activePipeline = inventory.pipelines[0];
        }
      },
    );
    vscode.window.showInformationMessage(
      `CF Migrate: discovered ${s.session.inventory?.pipelines.length ?? 0} pipeline(s).`,
    );
  } catch (err) {
    vscode.window.showErrorMessage(`Discovery failed: ${(err as Error).message}`);
  }
  ctx.onChange();
}

function runSetActive(ctx: CommandContext, rel: string | undefined): void {
  const s = ctx.services();
  if (!s) return noWorkspace();
  if (!rel) return;
  const target = s.session.inventory?.pipelines.find((p) => p.relativePath === rel);
  if (!target) {
    vscode.window.showWarningMessage(`CF Migrate: pipeline not discovered: ${rel}`);
    return;
  }
  s.session.activePipeline = target;
  // Clear downstream state — a new pipeline invalidates analysis/plan/generation.
  s.session.analysisResult = undefined;
  s.session.migrationPlan = undefined;
  s.session.generationManifest = undefined;
  s.session.phase = 'discovered';
  vscode.window.showInformationMessage(`CF Migrate: active pipeline set to ${rel}`);
  ctx.onChange();
}

async function runAnalyse(ctx: CommandContext): Promise<void> {
  const s = ctx.services();
  if (!s) return noWorkspace();
  const pipeline = await ensureActivePipeline(s);
  if (!pipeline) return;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'CF Migrate: analysing…', cancellable: false },
      async () => {
        s.session.phase = 'analysing';
        ctx.onChange();
        const result = await s.agents.analysis.analyse(pipeline);
        s.session.analysisResult = result;
        s.session.phase = 'analysed';
      },
    );
    vscode.window.showInformationMessage(
      `CF Migrate: analysis complete — ${s.session.analysisResult?.constructs.length ?? 0} constructs.`,
    );
  } catch (err) {
    s.session.phase = 'failed';
    s.session.lastError = { message: (err as Error).message, phase: 'analysing' };
    vscode.window.showErrorMessage(`Analysis failed: ${(err as Error).message}`);
  }
  ctx.onChange();
}

async function runPlan(ctx: CommandContext): Promise<void> {
  const s = ctx.services();
  if (!s) return noWorkspace();
  const pipeline = await ensureActivePipeline(s);
  if (!pipeline) return;
  if (!s.session.analysisResult) {
    vscode.window.showWarningMessage('Run CF Migrate: Analyse first.');
    return;
  }
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'CF Migrate: planning migration…' },
      async () => {
        s.session.phase = 'planning';
        ctx.onChange();
        const plan = await s.agents.planning.plan(pipeline, s.session.analysisResult!);
        s.session.migrationPlan = plan;
        s.session.phase = 'planned';
        // Run advisory recommendations in parallel; surface as a diagnostic log entry.
        try {
          const recs = await s.agents.recommendation.recommend(s.session.analysisResult!, plan);
          if (recs.length > 0) {
            vscode.window.showInformationMessage(
              `CF Migrate: ${recs.length} advisory recommendation(s) generated (see migration report).`,
            );
          }
        } catch {
          // non-fatal
        }
      },
    );
    s.session.phase = 'awaiting-approval';
    await vscode.commands.executeCommand('cf-migrate.openApproval');
  } catch (err) {
    s.session.phase = 'failed';
    s.session.lastError = { message: (err as Error).message, phase: 'planning' };
    vscode.window.showErrorMessage(`Planning failed: ${(err as Error).message}`);
  }
  ctx.onChange();
}

function runOpenApproval(ctx: CommandContext): void {
  const s = ctx.services();
  if (!s) return noWorkspace();
  ApprovalPanel.show(ctx.context, s, ctx.onChange);
}

async function runGenerate(ctx: CommandContext): Promise<void> {
  const s = ctx.services();
  if (!s) return noWorkspace();
  const pipeline = await ensureActivePipeline(s);
  if (!pipeline) return;
  if (!s.session.migrationPlan || !s.session.analysisResult) {
    vscode.window.showWarningMessage('Generate requires an approved plan. Run Analyse → Plan first.');
    return;
  }
  if (s.session.migrationPlan.approvalState.status !== 'approved') {
    vscode.window.showWarningMessage(
      'The migration plan must be approved before generation. Open the approval panel.',
    );
    return;
  }
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'CF Migrate: generating workflows…' },
      async () => {
        s.session.phase = 'generating';
        ctx.onChange();
        const manifest = await s.agents.generation.generate(
          pipeline,
          s.session.analysisResult!,
          s.session.migrationPlan!,
        );
        s.session.generationManifest = manifest;
        s.session.phase = 'generated';

        // Write workflow files under `.github/workflows/` in the workspace.
        const targetRoot = vscode.Uri.file(
          path.join(s.workspaceFolder.uri.fsPath, '.github', 'workflows'),
        );
        await vscode.workspace.fs.createDirectory(targetRoot);
        for (const wf of manifest.workflows) {
          const target = vscode.Uri.joinPath(targetRoot, wf.filename);
          await vscode.workspace.fs.writeFile(target, Buffer.from(wf.yamlContent, 'utf8'));
        }
      },
    );
    vscode.window.showInformationMessage(
      `CF Migrate: wrote ${s.session.generationManifest?.workflows.length ?? 0} workflow(s) to .github/workflows/`,
    );
    // Run validation automatically.
    await runValidate(ctx);
  } catch (err) {
    s.session.phase = 'failed';
    s.session.lastError = { message: (err as Error).message, phase: 'generating' };
    vscode.window.showErrorMessage(`Generation failed: ${(err as Error).message}`);
  }
  ctx.onChange();
}

async function runValidate(ctx: CommandContext): Promise<void> {
  const s = ctx.services();
  if (!s) return noWorkspace();
  if (!s.session.generationManifest || !s.session.migrationPlan || !s.session.analysisResult) return;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'CF Migrate: validating generated workflows…' },
      async () => {
        s.session.phase = 'validating';
        ctx.onChange();
        const updated = await s.agents.validation.validateAll(
          s.session.generationManifest!,
          s.session.analysisResult!,
          s.session.migrationPlan!,
        );
        s.session.generationManifest = updated;
        const allPassed = updated.workflows.every((w) => w.validationResult?.passed);
        s.session.phase = allPassed ? 'complete' : 'generated';
      },
    );
    const failing = s.session.generationManifest.workflows.filter(
      (w) => w.validationResult && !w.validationResult.passed,
    );
    if (failing.length === 0) {
      vscode.window.showInformationMessage('CF Migrate: all workflows passed validation ✅');
    } else {
      vscode.window.showWarningMessage(
        `CF Migrate: ${failing.length}/${s.session.generationManifest.workflows.length} workflows have validation issues. See the migration report.`,
      );
    }
  } catch (err) {
    s.session.phase = 'failed';
    s.session.lastError = { message: (err as Error).message, phase: 'validating' };
    vscode.window.showErrorMessage(`Validation failed: ${(err as Error).message}`);
  }
  ctx.onChange();
}

async function runOpenKB(ctx: CommandContext): Promise<void> {
  const s = ctx.services();
  if (!s) return noWorkspace();
  const items = await s.agents.kbManager.list();
  if (items.length === 0) {
    vscode.window.showInformationMessage(
      'CF Migrate KB is empty. Set `cfMigrate.kbPath` to a directory with snippets/patterns/templates.',
    );
    return;
  }
  const pick = await vscode.window.showQuickPick(
    items.map((item) => ({
      label: item.title,
      description: `${item.type} — ${item.id}`,
      detail: item.description,
      item,
    })),
    { matchOnDescription: true, matchOnDetail: true, placeHolder: 'Search the knowledge base' },
  );
  if (!pick) return;
  const file = path.join(s.kbStore.rootDir, `${pick.item.type}s`, `${pick.item.id}.md`);
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(doc);
}

async function runIndexGHA(ctx: CommandContext): Promise<void> {
  // Placeholder — the full org-index crawler lives outside this scope.
  vscode.window.showInformationMessage(
    'CF Migrate: configure `cfMigrate.ghaRepoPaths` with local GHA repo clones, then re-run this command. (Crawler coming in a later release.)',
  );
}

async function runShowReport(ctx: CommandContext): Promise<void> {
  const s = ctx.services();
  if (!s) return noWorkspace();
  const report = buildMarkdownReport(s);
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: report });
  await vscode.window.showTextDocument(doc, { preview: true });
}

function buildMarkdownReport(s: ExtensionServices): string {
  const lines: string[] = [];
  lines.push('# CF Migrate — Migration Report', '');
  lines.push(`- **Workspace:** ${s.workspaceFolder.name}`);
  lines.push(`- **Phase:** ${s.session.phase}`);
  lines.push(`- **LLM:** ${s.llmAvailable ? 'Copilot' : 'deterministic (no LLM)'}`);
  if (s.session.activePipeline) {
    lines.push(`- **Active pipeline:** \`${s.session.activePipeline.relativePath}\``);
  }
  lines.push('');

  if (s.session.analysisResult) {
    const a = s.session.analysisResult;
    lines.push('## Analysis', '');
    lines.push(`- Constructs: ${a.constructs.length}`);
    lines.push(`- Complexity: ${a.complexityScore.toFixed(2)}`);
    lines.push(`- Proposed workflows: ${a.structuralRecommendation.proposedWorkflows.length}`);
    lines.push('');
  }

  if (s.session.migrationPlan) {
    const p = s.session.migrationPlan;
    lines.push('## Plan', '');
    lines.push(`- Items: ${p.items.length} (${p.items.filter((i) => i.requiresReview).length} need review)`);
    lines.push(`- Status: **${p.approvalState.status}**`);
    lines.push('');
    for (const item of p.items) {
      lines.push(
        `### #${item.sequenceNumber}. ${item.ghaRecommendation.actionOrPattern} — _tier ${item.confidenceTier}_`,
      );
      lines.push(`- CF: \`${item.cfConstructRef.constructType}\` (line ${item.cfConstructRef.lineStart})`);
      if (item.targetWorkflow) lines.push(`- Target: \`${item.targetWorkflow}\``);
      lines.push(`- Status: **${item.status}**`);
      lines.push(`- Rationale: ${item.rationale}`);
      if (item.kbSnippetId) lines.push(`- KB: \`${item.kbSnippetId}\``);
      lines.push('');
    }
  }

  if (s.session.generationManifest) {
    lines.push('## Generated Workflows', '');
    for (const wf of s.session.generationManifest.workflows) {
      lines.push(`### \`${wf.filename}\``);
      const v = wf.validationResult;
      if (v) {
        lines.push(
          `- Validation: ${v.passed ? '✅ passed' : '❌ failed'} (` +
            `${v.schemaErrors.length} schema errors, ${v.lintErrors.length} lint errors, ` +
            `${v.securityIssues.length} security issues)`,
        );
        for (const e of v.schemaErrors.slice(0, 10)) {
          lines.push(`  - ❗ ${e.message}${e.line ? ` (line ${e.line})` : ''}`);
        }
        for (const w of v.lintErrors.slice(0, 10)) {
          lines.push(`  - ⚠️ ${w.message}${w.line ? ` (line ${w.line})` : ''}`);
        }
        for (const sec of v.securityIssues.slice(0, 10)) {
          lines.push(`  - 🔐 ${sec.description}${sec.line ? ` (line ${sec.line})` : ''}`);
        }
      }
      lines.push(`- Used KB items: ${wf.usedKbItems.join(', ') || '(none)'}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ───────────────────────────────────────────────────────────── helpers ─

async function ensureActivePipeline(s: ExtensionServices): Promise<PipelineFile | undefined> {
  if (s.session.activePipeline) return s.session.activePipeline;
  const pipelines = s.session.inventory?.pipelines ?? [];
  if (pipelines.length === 0) {
    await vscode.commands.executeCommand('cf-migrate.discover');
    const refreshed = s.session.inventory?.pipelines ?? [];
    if (refreshed.length === 0) {
      vscode.window.showWarningMessage('CF Migrate: no Codefresh pipelines found in this workspace.');
      return undefined;
    }
  }
  const list = s.session.inventory!.pipelines;
  if (list.length === 1) {
    s.session.activePipeline = list[0];
    return list[0];
  }
  const pick = await vscode.window.showQuickPick(
    list.map((p) => ({ label: p.relativePath, p })),
    { placeHolder: 'Select a pipeline to work on' },
  );
  if (!pick) return undefined;
  s.session.activePipeline = pick.p;
  return pick.p;
}

function noWorkspace(): void {
  vscode.window.showWarningMessage('CF Migrate: open a folder containing your Codefresh pipeline first.');
}
