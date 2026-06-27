// Map Run side-by-side diff panel.
//
// Renders the full Codefresh source YAML and the suggested GHA workflow YAML
// in two scrollable panes. Every mapped step is wrapped in a colour-coded
// block (border-left + tinted background). SVG bezier threads connect each
// CF step title to the corresponding GHA "- name:" line. Steps can be
// individually collapsed to show only their title bar.
//
// All step blocks — including manual_review — are rendered. The red left
// border and background are applied via div styling (border-left on <tr>
// does not work in collapsed tables, which was the original bug).

import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

import { parseYaml, stringify as stringifyYaml, uuid } from '@cf-migrate/core';
import type { MapRunFile, MapRunMapping } from '@cf-migrate/core';
import { callWithRetry, LearnedRuleSchema } from '@cf-migrate/llm';
import type { LearnedRule } from '@cf-migrate/llm';

import type { MapRunEntry } from '../scanners/MapRunScanner';
import type { ExtensionServices } from '../services/ExtensionServices';
import { buildTopologyGraphs } from '../generation/buildTopologyGraphs';
import { renderTopologyGraph, type TopoGraph } from '../generation/TopologyDiagram';

interface StepRange { start: number; end: number }

// One row of the *.edits.json sidecar — a before/after snapshot of a manual GHA edit,
// scoped to whichever step was selected at save time (or the whole file if none was).
interface EditRecord {
  id: string;
  seq: number | null;
  cf_step?: string;
  gha_step?: string;
  timestamp: string;
  before: string;
  after: string;
}

interface EditLog { version: 1; pipeline_name: string; edits: EditRecord[] }

interface CfTrigger { type?: string; name?: string; repo?: string; events?: string[]; branchRegex?: string; disabled?: boolean }

interface CfContext {
  triggers: CfTrigger[];
  contexts: string[];
  declaredVariables: { key: string; value?: string; encrypted?: boolean }[];
  referencedVars: string[];
  exportedVars: string[];
}

interface GhaContext {
  on: Record<string, unknown>;
  env: Record<string, unknown>;
  secrets: string[];
  vars: string[];
}

interface VarRow { name: string; cfKind: 'exported' | 'declared' | 'context' | null; ghaKind: 'secret' | 'var' | 'env' | null }

export class MapRunDiffPanel {
  private static readonly panels = new Map<string, MapRunDiffPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static async show(
    context: vscode.ExtensionContext,
    entry: MapRunEntry,
    servicesGetter: () => ExtensionServices | undefined = () => undefined,
  ): Promise<void> {
    // Re-render on reopen, not just reveal — otherwise a panel left open from before a
    // code change (or a file edit on disk) keeps showing whatever it had at creation time,
    // which looks identical to a rendering regression until the whole window is reloaded.
    const existing = MapRunDiffPanel.panels.get(entry.filePath);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      await existing.render();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'cf-migrate.mapRunDiff',
      `Map Run — ${entry.data.meta.pipeline_name}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    new MapRunDiffPanel(panel, entry, context, servicesGetter);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly entry: MapRunEntry,
    _context: vscode.ExtensionContext,
    private readonly servicesGetter: () => ExtensionServices | undefined,
  ) {
    this.panel = panel;
    MapRunDiffPanel.panels.set(entry.filePath, this);
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (m: { type: string; [k: string]: unknown }) => void this.handleMessage(m),
      undefined, this.disposables,
    );
    void this.render();
  }

  // Sidecar next to the .map.json — same basename, .edits.json instead of .map.json.
  private editsFilePath(): string {
    return this.entry.filePath.replace(/\.map\.json$/, '').concat('.edits.json');
  }

  private async readEditLog(): Promise<EditLog> {
    const raw = await readFile(this.editsFilePath());
    if (!raw) return { version: 1, pipeline_name: this.entry.data.meta.pipeline_name, edits: [] };
    try {
      return JSON.parse(raw) as EditLog;
    } catch {
      return { version: 1, pipeline_name: this.entry.data.meta.pipeline_name, edits: [] };
    }
  }

  private async appendEdit(record: EditRecord): Promise<void> {
    const log = await this.readEditLog();
    log.edits.push(record);
    await fs.writeFile(this.editsFilePath(), JSON.stringify(log, null, 2), 'utf8');
  }

  private async handleMessage(msg: { type: string; [k: string]: unknown }): Promise<void> {
    if (msg.type === 'openFile') {
      const rel = msg.path as string;
      const full = path.resolve(this.entry.workspaceFolder.uri.fsPath, rel);
      try {
        await fs.access(full);
        const doc = await vscode.workspace.openTextDocument(full);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      } catch {
        void vscode.window.showWarningMessage(`File not found: ${rel}`);
      }
    } else if (msg.type === 'saveGhaYaml') {
      await this.handleSaveGhaYaml(msg.content as string, (msg.seq as number | null) ?? null);
    } else if (msg.type === 'learnRule') {
      await this.handleLearnRule(msg.editId as string);
    }
  }

  private async handleSaveGhaYaml(content: string, seq: number | null): Promise<void> {
    const { data, workspaceFolder } = this.entry;
    const full = path.resolve(workspaceFolder.uri.fsPath, data.meta.target_workflow);
    try {
      const before = (await readFile(full)) ?? '';
      await fs.writeFile(full, content, 'utf8');

      const mapping = seq !== null ? data.mappings.find(m => m.seq === seq) : undefined;
      const beforeRange = seq !== null ? parseGHARanges(before, data.mappings)[seq] : undefined;
      const afterRange  = seq !== null ? parseGHARanges(content, data.mappings)[seq] : undefined;

      await this.appendEdit({
        id: uuid(),
        seq,
        cf_step: mapping?.cf_step,
        gha_step: mapping?.gha_step,
        timestamp: new Date().toISOString(),
        before: beforeRange ? extractLines(before, beforeRange) : before,
        after: afterRange ? extractLines(content, afterRange) : content,
      });

      await this.render();
    } catch (err) {
      void vscode.window.showErrorMessage(`Failed to save ${data.meta.target_workflow}: ${String(err)}`);
    }
  }

  private async handleLearnRule(editId: string): Promise<void> {
    const services = this.servicesGetter();
    if (!services) {
      void vscode.window.showErrorMessage('CF Migrate services are not ready yet — try again once the workspace finishes loading.');
      return;
    }
    if (!services.llmAvailable) {
      void vscode.window.showErrorMessage(
        'Learn Rule requires GitHub Copilot Chat — install it and sign in, then try again. (This feature only uses the Copilot-provided model, never a deterministic fallback.)',
      );
      return;
    }

    const log = await this.readEditLog();
    const record = log.edits.find(e => e.id === editId) ?? log.edits[log.edits.length - 1];
    if (!record) {
      void vscode.window.showWarningMessage('No manual edits recorded yet for this map run — edit and save a GHA step first.');
      return;
    }

    const mapping = record.seq !== null ? this.entry.data.mappings.find(m => m.seq === record.seq) : undefined;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Learning rule from manual edit…' },
      async () => {
        try {
          const { systemPrompt, userMessage } = await services.promptRenderer.render('rule-learning', {
            EARLIER_MAPPING_JSON: JSON.stringify(mapping ?? { note: 'No specific step was selected; edit spans the whole file.' }, null, 2),
            BEFORE_SNIPPET: record.before,
            AFTER_SNIPPET: record.after,
          });

          // cfMigrate.learnRuleModel pins a specific Copilot model family for this feature
          // (set via "CF Migrate: Select Learn Rule Model"); empty means let the provider's
          // own best-available heuristic pick, the closest proxy for "Copilot Chat's default".
          const learnRuleModel = vscode.workspace.getConfiguration('cfMigrate').get<string>('learnRuleModel', '');

          const rule: LearnedRule = await callWithRetry({
            client: services.llm,
            request: {
              model: learnRuleModel ? `copilot/${learnRuleModel}` : 'copilot',
              systemPrompt,
              userMessage,
              temperature: 0.2,
              maxTokens: 2000,
              jsonMode: true,
            },
            schema: LearnedRuleSchema,
            ledger: services.ledger,
            phase: 'rule-learning',
          });

          await this.appendRuleToYaml(rule, mapping);
          const kbItem = await services.agents.kbManager.create({
            title: rule.title,
            type: 'pattern',
            cfConstructs: [rule.cf_construct],
            ghaConstructs: rule.gha_constructs,
            tags: rule.tags ?? [],
            confidence: rule.confidence,
            usageCount: 0,
            authors: ['learned-from-manual-edit'],
            description: rule.description,
            content: renderRuleMarkdown(rule, record),
            cfExample: record.before,
            ghaExample: rule.action_template,
            edgeNotes: rule.rationale,
          });

          void vscode.window.showInformationMessage(
            `Learned rule "${rule.rule_id}" — added to ${path.basename(this.entry.data.meta.mapping_source)} and knowledge base (${kbItem.id}).`,
          );
        } catch (err) {
          void vscode.window.showErrorMessage(`Failed to learn rule: ${String(err)}`);
        }
      },
    );
  }

  private async appendRuleToYaml(rule: LearnedRule, mapping: MapRunMapping | undefined): Promise<void> {
    const full = path.resolve(this.entry.workspaceFolder.uri.fsPath, this.entry.data.meta.mapping_source);
    const raw = await readFile(full);
    let rules: unknown[] = [];
    if (raw) {
      try {
        const parsed = parseYaml(raw);
        if (Array.isArray(parsed)) rules = parsed;
      } catch {
        rules = [];
      }
    }
    rules.push({
      ...rule,
      learned_from_rule_id: mapping?.rule_id,
      learned_at: new Date().toISOString(),
      source: 'manual-edit',
    });
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, stringifyYaml(rules), 'utf8');
  }

  private async render(): Promise<void> {
    const { data, workspaceFolder } = this.entry;
    const root = workspaceFolder.uri.fsPath;

    const cfYaml  = await readFile(path.resolve(root, data.meta.source_file))
                 ?? generateCFYaml(data.mappings);
    const ghaYaml = await readFile(path.resolve(root, data.meta.target_workflow))
                 ?? generateGHAYaml(data.mappings);

    const cfRanges  = parseCFRanges(cfYaml,  data.mappings);
    const ghaRanges = parseGHARanges(ghaYaml, data.mappings);

    const cfExists  = await exists(path.resolve(root, data.meta.source_file));
    const ghaExists = await exists(path.resolve(root, data.meta.target_workflow));

    const cfCtx  = parseCfContext(cfYaml);
    const ghaCtx = parseGhaContext(ghaYaml);
    const varRows = buildVarRows(cfCtx, ghaCtx);

    const editLog = await this.readEditLog();
    const latestEdit = editLog.edits[editLog.edits.length - 1] ?? null;

    const topology = await buildTopologyGraphs(this.entry, root);

    this.panel.webview.html = buildHtml(
      data, cfYaml, ghaYaml, cfRanges, ghaRanges, cfExists, ghaExists, cfCtx, ghaCtx, varRows, latestEdit, topology,
    );
  }

  private dispose(): void {
    MapRunDiffPanel.panels.delete(this.entry.filePath);
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

// ── File helpers ──────────────────────────────────────────────────────────────

async function readFile(p: string): Promise<string | null> {
  try { return await fs.readFile(p, 'utf8'); } catch { return null; }
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

function extractLines(content: string, range: StepRange): string {
  return content.split('\n').slice(range.start, range.end + 1).join('\n');
}

function renderRuleMarkdown(rule: LearnedRule, record: EditRecord): string {
  return `## ${rule.title}

${rule.description}

### Before (Codefresh)
\`\`\`yaml
${record.before}
\`\`\`

### After (manually corrected GHA)
\`\`\`yaml
${record.after}
\`\`\`

### Action template
\`\`\`yaml
${rule.action_template}
\`\`\`

### Why
${rule.rationale}
`;
}

// ── YAML step-range parsers ───────────────────────────────────────────────────

function parseCFRanges(yaml: string, mappings: MapRunMapping[]): Record<number, StepRange> {
  const lines = yaml.split('\n');
  const result: Record<number, StepRange> = {};

  // Locate the "steps:" keyword and its indent level
  let stepsIndent = -1;
  let stepsLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimStart();
    if (t === 'steps:') { stepsIndent = lines[i].length - t.length; stepsLine = i; break; }
  }
  if (stepsLine === -1) return result;

  // Each step name sits at stepsIndent+2 and ends with ':'
  const stepIndent = stepsIndent + 2;
  const stepRe = new RegExp(`^\\s{${stepIndent}}([a-z_][a-z0-9_]*):\\s*$`);
  const found: { name: string; line: number }[] = [];

  for (let i = stepsLine + 1; i < lines.length; i++) {
    const m = lines[i].match(stepRe);
    if (m) found.push({ name: m[1], line: i });
    // Stop if we return to the steps-block indent level with a non-blank key
    const t = lines[i].trimStart();
    const ind = lines[i].length - t.length;
    if (i > stepsLine && ind <= stepsIndent && t && !t.startsWith('#')) break;
  }

  for (let j = 0; j < found.length; j++) {
    const end = j + 1 < found.length ? found[j + 1].line - 1 : lines.length - 1;
    const mapping = mappings.find(m => m.cf_step === found[j].name);
    if (mapping) result[mapping.seq] = { start: found[j].line, end };
  }
  return result;
}

// Real-world generated YAML often quotes step names that contain special characters
// (parentheses, colons, …) — `- name: "AWS OIDC Authoriser (MANUAL REVIEW)"` — while
// map.json's gha_step is the plain unquoted text. Strip a single matching pair of quotes
// (and any trailing inline comment) before comparing, so the match isn't exact-string-only.
function normalizeStepName(raw: string): string {
  let s = raw.trim();
  const quoted = s.match(/^(['"])(.*)\1$/);
  if (quoted) s = quoted[2];
  return s.trim();
}

function parseGHARanges(yaml: string, mappings: MapRunMapping[]): Record<number, StepRange> {
  const lines = yaml.split('\n');
  const result: Record<number, StepRange> = {};

  const found: { name: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s+- name:\s+(.+)$/);
    if (m) found.push({ name: normalizeStepName(m[1]), line: i });
  }

  for (let j = 0; j < found.length; j++) {
    const end = j + 1 < found.length ? found[j + 1].line - 1 : lines.length - 1;
    const mapping = mappings.find(m => normalizeStepName(m.gha_step) === found[j].name);
    if (mapping) result[mapping.seq] = { start: found[j].line, end };
  }
  return result;
}

// ── Pipeline-level context parsers ────────────────────────────────────────────
// Extracted directly from the CF pipeline source and the suggested GHA workflow
// (not from map.json) — triggers/contexts/variables on the CF side, on:/env:/
// secrets on the GHA side, so the panel reflects whatever is actually in the
// files rather than a potentially stale snapshot.

function parseCfContext(yaml: string): CfContext {
  let doc: Record<string, unknown> = {};
  try { doc = (parseYaml(yaml) as Record<string, unknown>) ?? {}; } catch { doc = {}; }
  const spec = (doc.spec as Record<string, unknown>) ?? {};

  const triggers = Array.isArray(spec.triggers) ? (spec.triggers as CfTrigger[]) : [];
  const contexts = Array.isArray(spec.contexts) ? (spec.contexts as string[]) : [];

  let declaredVariables: CfContext['declaredVariables'] = [];
  const rawVars = spec.variables;
  if (Array.isArray(rawVars)) {
    declaredVariables = rawVars as CfContext['declaredVariables'];
  } else if (rawVars && typeof rawVars === 'object') {
    declaredVariables = Object.entries(rawVars as Record<string, unknown>)
      .map(([key, value]) => ({ key, value: String(value) }));
  }

  const exportedVars = Array.from(new Set(
    Array.from(yaml.matchAll(/cf_export\s+([A-Z][A-Z0-9_]*)/g)).map(m => m[1]),
  )).sort();

  // ${{VAR}} references that look like CF context/secret vars (ALL_CAPS), excluding
  // built-in CF_* runtime vars — those have no user-managed equivalent to migrate.
  const referencedVars = Array.from(new Set(
    Array.from(yaml.matchAll(/\$\{\{\s*([A-Z][A-Z0-9_]*)\s*\}\}/g))
      .map(m => m[1])
      .filter(n => !n.startsWith('CF_')),
  )).sort();

  return { triggers, contexts, declaredVariables, referencedVars, exportedVars };
}

function parseGhaContext(yaml: string): GhaContext {
  let doc: Record<string, unknown> = {};
  try { doc = (parseYaml(yaml) as Record<string, unknown>) ?? {}; } catch { doc = {}; }
  const on  = (doc.on  && typeof doc.on  === 'object') ? (doc.on  as Record<string, unknown>) : {};
  const env = (doc.env && typeof doc.env === 'object') ? (doc.env as Record<string, unknown>) : {};

  // Negative lookbehind excludes "steps.<id>.secrets"/"steps.vars" style chains —
  // only match the bare GHA `secrets.X` / `vars.X` context, not a step id named that.
  const secrets = Array.from(new Set(
    Array.from(yaml.matchAll(/(?<![.\w])secrets\.([A-Za-z0-9_]+)/g)).map(m => m[1]),
  )).sort();
  const vars = Array.from(new Set(
    Array.from(yaml.matchAll(/(?<![.\w])vars\.([A-Za-z0-9_]+)/g)).map(m => m[1]),
  )).sort();

  return { on, env, secrets, vars };
}

// Single shared row list — rendered in the same order on both sides so each CF
// variable/context lines up with whatever GHA secrets./vars./env. reference it.
function buildVarRows(cf: CfContext, gha: GhaContext): VarRow[] {
  const names = new Set<string>([
    ...cf.declaredVariables.map(v => v.key),
    ...cf.referencedVars,
    ...gha.secrets,
    ...gha.vars,
    ...Object.keys(gha.env),
  ]);

  const rows: VarRow[] = [];
  for (const name of Array.from(names).sort()) {
    const cfKind: VarRow['cfKind'] =
      cf.exportedVars.includes(name) ? 'exported' :
      cf.declaredVariables.some(v => v.key === name) ? 'declared' :
      cf.referencedVars.includes(name) ? 'context' : null;

    const ghaKind: VarRow['ghaKind'] =
      gha.secrets.includes(name) ? 'secret' :
      gha.vars.includes(name) ? 'var' :
      Object.prototype.hasOwnProperty.call(gha.env, name) ? 'env' : null;

    if (cfKind || ghaKind) rows.push({ name, cfKind, ghaKind });
  }
  return rows;
}

// ── Pipeline-context section renderers ────────────────────────────────────────

function ctxPills(items: string[], cls: string): string {
  if (!items.length) return '';
  return items.map(s => `<span class="ctx-pill ${cls}">${esc(s)}</span>`).join('');
}

function renderCfCtxHtml(cf: CfContext, rows: VarRow[]): string {
  const triggerPills = cf.triggers.length
    ? cf.triggers.map(t => `<span class="ctx-pill trig">${esc(t.type ?? 'trigger')}${t.name ? ': ' + esc(t.name) : ''}</span>`).join('')
    : '<span class="ctx-empty">Not defined in pipeline file — likely configured via Codefresh UI/API</span>';

  const contextPills = cf.contexts.length
    ? ctxPills(cf.contexts, 'ctxname')
    : '<span class="ctx-empty">No spec.contexts declared</span>';

  const varRows = rows.length
    ? rows.map(r => `<div class="ctx-var-row">
        <span class="ctx-var-name">${esc(r.name)}</span>
        <span class="ctx-var-badge ${r.cfKind ?? 'absent'}">${r.cfKind ? esc(r.cfKind) : '—'}</span>
      </div>`).join('')
    : '<span class="ctx-empty">None detected</span>';

  return `<div class="ctx-block" id="cf-ctx">
    <div class="ctx-hdr" onclick="toggleCtx('cf')">
      <button class="col-btn" id="cf-ctx-tg" title="Collapse/expand">▾</button>
      <span>Pipeline Context</span>
    </div>
    <div class="ctx-body" id="cf-ctx-body">
      <div class="ctx-row"><span class="ctx-label">Triggers</span><div class="ctx-flow">${triggerPills}</div></div>
      <div class="ctx-row"><span class="ctx-label">Contexts</span><div class="ctx-flow">${contextPills}</div></div>
      <div class="ctx-row ctx-row-vars"><span class="ctx-label">Variables</span><div class="ctx-vars">${varRows}</div></div>
    </div>
  </div>`;
}

function renderGhaCtxHtml(gha: GhaContext, rows: VarRow[]): string {
  const onKeys = Object.keys(gha.on);
  const triggerPills = onKeys.length
    ? ctxPills(onKeys, 'trig')
    : '<span class="ctx-empty">No on: block found</span>';

  const envKeys = Object.keys(gha.env);
  const envPills = envKeys.length
    ? ctxPills(envKeys, 'envname')
    : '<span class="ctx-empty">No workflow-level env: block</span>';

  const ghaLabel = (k: VarRow['ghaKind'], name: string): string => {
    if (k === 'secret') return 'secrets.' + name;
    if (k === 'var')    return 'vars.' + name;
    if (k === 'env')    return 'env.' + name;
    return '—';
  };

  const varRows = rows.length
    ? rows.map(r => `<div class="ctx-var-row">
        <span class="ctx-var-name">${esc(r.name)}</span>
        <span class="ctx-var-badge ${r.ghaKind ?? 'absent'}">${esc(ghaLabel(r.ghaKind, r.name))}</span>
      </div>`).join('')
    : '<span class="ctx-empty">None detected</span>';

  return `<div class="ctx-block" id="gha-ctx">
    <div class="ctx-hdr" onclick="toggleCtx('gha')">
      <button class="col-btn" id="gha-ctx-tg" title="Collapse/expand">▾</button>
      <span>Triggers &amp; Environment</span>
    </div>
    <div class="ctx-body" id="gha-ctx-body">
      <div class="ctx-row"><span class="ctx-label">Triggers</span><div class="ctx-flow">${triggerPills}</div></div>
      <div class="ctx-row"><span class="ctx-label">Environment</span><div class="ctx-flow">${envPills}</div></div>
      <div class="ctx-row ctx-row-vars"><span class="ctx-label">Secrets &amp; Vars</span><div class="ctx-vars">${varRows}</div></div>
    </div>
  </div>`;
}

// ── Synthetic YAML fallbacks ──────────────────────────────────────────────────

function generateCFYaml(mappings: MapRunMapping[]): string {
  let y = 'version: "1.0"\nspec:\n  steps:\n';
  let lastStage = '';
  for (const m of mappings) {
    if (m.cf_stage !== lastStage) { y += `\n    # stage: ${m.cf_stage}\n`; lastStage = m.cf_stage; }
    y += `    ${m.cf_step}:\n      title: ${m.cf_title}\n      type: ${m.cf_type}\n      stage: ${m.cf_stage}\n`;
  }
  return y;
}

function generateGHAYaml(mappings: MapRunMapping[]): string {
  let y = 'name: Migrated Workflow\non:\n  push:\n    branches: [main]\njobs:\n';
  const byJob = new Map<string, MapRunMapping[]>();
  for (const m of mappings) { const a = byJob.get(m.gha_job) ?? []; a.push(m); byJob.set(m.gha_job, a); }
  for (const [job, steps] of byJob) {
    y += `  ${job}:\n    runs-on: ubuntu-latest\n    steps:\n`;
    for (const m of steps) { y += `      - name: ${m.gha_step}\n        ${m.action}\n`; }
  }
  return y;
}

// ── HTML builder ──────────────────────────────────────────────────────────────

function buildHtml(
  data: MapRunFile,
  cfYaml: string,
  ghaYaml: string,
  cfRanges: Record<number, StepRange>,
  ghaRanges: Record<number, StepRange>,
  cfExists: boolean,
  ghaExists: boolean,
  cfCtx: CfContext,
  ghaCtx: GhaContext,
  varRows: VarRow[],
  latestEdit: EditRecord | null,
  topology: { cf: TopoGraph; gha: TopoGraph },
): string {
  const { meta } = data;

  // Embed JSON safely — escape </script> inside the string value
  const safeJson = JSON.stringify({
    meta,
    mappings: data.mappings,
    cfYaml,
    ghaYaml,
    cfRanges,
    ghaRanges,
    latestEditId: latestEdit?.id ?? null,
  }).replace(/<\/script>/gi, '<\\/script>');

  const cfCtxHtml  = renderCfCtxHtml(cfCtx, varRows);
  const ghaCtxHtml = renderGhaCtxHtml(ghaCtx, varRows);
  const cfTopoHtml  = renderTopologyGraph(topology.cf, 'cf-topo');
  const ghaTopoHtml = renderTopologyGraph(topology.gha, 'gha-topo');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';"/>
<style>
/* ── Reset & base ─────────────────────────────────────────────────── */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:var(--vscode-font-family);
  font-size:var(--vscode-font-size);
  color:var(--vscode-foreground);
  background:var(--vscode-editor-background);
  display:flex;flex-direction:column;height:100vh;overflow:hidden;
}

/* ── Header ───────────────────────────────────────────────────────── */
.hdr{
  flex-shrink:0;padding:10px 16px;
  border-bottom:1px solid var(--vscode-panel-border);
  display:flex;align-items:flex-start;gap:12px;
}
.hdr-info{flex:1;min-width:0}
.hdr-title{font-weight:700;font-size:1em;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hdr-sub{font-size:0.8em;color:var(--vscode-descriptionForeground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hdr-sub a{color:var(--vscode-textLink-foreground);cursor:pointer;text-decoration:underline}
.hdr-sub a:hover{opacity:0.8}
.hdr-stats{display:flex;gap:6px;align-items:center;flex-shrink:0}
.bdg{display:inline-block;padding:2px 9px;border-radius:10px;font-size:0.76em;font-weight:700;white-space:nowrap}
.bdg-mapped{background:rgba(60,200,120,.18);color:#3cc878}
.bdg-fallback{background:rgba(232,156,60,.18);color:#e89c3c}
.bdg-manual{background:rgba(220,80,80,.18);color:#dc5050}

/* ── Topology view (authoring / execution plane diagrams) ───────────── */
.topo-view{flex:1;display:flex;overflow:auto;gap:0}
.topo-view.hidden{display:none}
.topo-graph{flex:1 1 0;min-width:0;padding:16px;border-right:1px solid var(--vscode-panel-border)}
.topo-graph:last-child{border-right:none}
.topo-graph-title{font-size:.78em;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--vscode-descriptionForeground);margin-bottom:12px}
.topo-canvas{position:relative}
.topo-box{
  position:absolute;display:flex;flex-direction:column;align-items:center;justify-content:center;
  text-align:center;padding:4px 8px;border:1.5px solid;border-radius:8px;
  background:var(--vscode-editor-background);box-shadow:0 1px 3px rgba(0,0,0,.2);
}
.topo-box-label{font-size:.8em;font-weight:600;word-break:break-word}
.topo-box-sub{font-size:.7em;opacity:.65;margin-top:2px;word-break:break-word}

/* ── Split view ───────────────────────────────────────────────────── */
.split{flex:1;display:flex;overflow:hidden;position:relative}
.split.hidden{display:none}

.pane{flex:1 1 0;display:flex;flex-direction:column;overflow:hidden;min-width:0}
.pane+.pane{border-left:1px solid var(--vscode-panel-border)}

.pane-hdr{
  flex-shrink:0;padding:5px 12px;
  background:var(--vscode-sideBar-background,var(--vscode-editor-background));
  border-bottom:1px solid var(--vscode-panel-border);
  font-size:0.78em;font-weight:700;letter-spacing:.05em;text-transform:uppercase;
  color:var(--vscode-descriptionForeground);
  display:flex;align-items:center;gap:8px;
}
.pane-hdr a{
  font-weight:400;text-transform:none;letter-spacing:0;
  color:var(--vscode-textLink-foreground);cursor:pointer;text-decoration:none;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.pane-hdr a:hover{text-decoration:underline}

.hdr-spacer{flex:1}
.edit-actions{display:flex;gap:6px;flex-shrink:0}
.edit-actions.hidden{display:none}
.edit-btn{
  font-family:var(--vscode-font-family);font-size:.85em;font-weight:600;
  text-transform:none;letter-spacing:0;
  background:var(--vscode-button-secondaryBackground,rgba(255,255,255,.08));
  color:var(--vscode-button-secondaryForeground,var(--vscode-foreground));
  border:none;border-radius:4px;padding:2px 9px;cursor:pointer;
}
.edit-btn:hover{filter:brightness(1.15)}
.edit-btn:disabled{opacity:.4;cursor:default;filter:none}
.edit-btn.save{
  background:var(--vscode-button-background,#3cc878);
  color:var(--vscode-button-foreground,#fff);
}
.edit-btn.learn{
  background:rgba(155,109,255,.18);color:#9b6dff;
}

/* ── Pipeline context (triggers / variables / contexts / env / secrets) ──── */
.ctx-block{flex-shrink:0;border-bottom:1px solid var(--vscode-panel-border)}
.ctx-hdr{
  display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;
  padding:4px 12px;font-size:.78em;font-weight:700;letter-spacing:.03em;
  color:var(--vscode-descriptionForeground);
  background:var(--vscode-sideBar-background,var(--vscode-editor-background));
}
.ctx-hdr:hover{background:var(--vscode-editor-hoverHighlightBackground,rgba(255,255,255,.04))}
.ctx-body{padding:6px 14px 10px}
.ctx-block.collapsed .ctx-body{display:none}
.ctx-block.collapsed .col-btn{transform:rotate(-90deg)}

.ctx-row{display:flex;gap:8px;align-items:flex-start;margin-bottom:5px;flex-wrap:wrap}
.ctx-label{
  flex-shrink:0;width:84px;padding-top:2px;
  font-size:.74em;font-weight:700;letter-spacing:.03em;text-transform:uppercase;
  opacity:.55;
}
.ctx-flow{display:flex;flex-wrap:wrap;gap:4px;flex:1;min-width:0}
.ctx-pill{
  display:inline-block;padding:1px 8px;border-radius:8px;font-size:.78em;
  background:rgba(255,255,255,.06);border:1px solid var(--vscode-panel-border);
}
.ctx-pill.trig{border-color:rgba(78,166,255,.4);color:#4ea6ff}
.ctx-pill.ctxname,.ctx-pill.envname{border-color:rgba(160,160,160,.4)}
.ctx-empty{font-size:.8em;opacity:.45;font-style:italic}

.ctx-vars{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
.ctx-var-row{display:flex;align-items:center;gap:8px}
.ctx-var-name{font-family:var(--vscode-editor-font-family,monospace);font-size:.8em;min-width:150px}
.ctx-var-badge{font-size:.72em;font-weight:600;padding:1px 7px;border-radius:7px;white-space:nowrap}
.ctx-var-badge.exported,.ctx-var-badge.declared,.ctx-var-badge.secret,.ctx-var-badge.env{
  background:rgba(60,200,120,.18);color:#3cc878;
}
.ctx-var-badge.context,.ctx-var-badge.var{background:rgba(232,156,60,.18);color:#e89c3c}
.ctx-var-badge.absent{background:transparent;color:var(--vscode-descriptionForeground);opacity:.45}

.pane-scroll{flex:1;overflow:auto}

.pane-content{
  font-family:var(--vscode-editor-font-family,monospace);
  font-size:0.85em;line-height:1.5;
  padding:6px 0;
}
.pane-content.hidden{display:none}

.pane-editor{
  display:block;box-sizing:border-box;width:100%;height:100%;
  background:var(--vscode-editor-background);
  color:var(--vscode-editor-foreground,var(--vscode-foreground));
  font-family:var(--vscode-editor-font-family,monospace);
  font-size:0.85em;line-height:1.5;
  border:none;outline:none;resize:none;overflow:auto;
  padding:6px 14px;white-space:pre;tab-size:2;
}
.pane-editor.hidden{display:none}

/* ── Code lines ───────────────────────────────────────────────────── */
.cl{display:block;padding:0 14px;white-space:pre;cursor:default}
.cl:hover{background:var(--vscode-editor-hoverHighlightBackground,rgba(255,255,255,.04))}
.yc{color:#6a737d;opacity:.75}                   /* comment  */
.yk{color:var(--vscode-symbolIcon-variableColor,#9cdcfe)}  /* key      */
.yv{color:var(--vscode-symbolIcon-stringColor,#ce9178)}    /* value    */
.yn{color:var(--vscode-symbolIcon-nameColor,#4ec9b0)}      /* name val */
.yd{color:var(--vscode-symbolIcon-operatorColor,#d4d4d4)}  /* dash -   */

/* ── Step blocks ──────────────────────────────────────────────────── */
.sb{position:relative;margin:0}

/* Gutter mark — thin confidence bar on the outer edge of each pane */
.g-mark{
  position:absolute;top:0;bottom:0;width:3px;pointer-events:none;opacity:.85;
}
.pane-cf  .g-mark{left:0;border-radius:0 2px 2px 0}
.pane-gha .g-mark{right:0;border-radius:2px 0 0 2px}

/* Step title bar — compact, minimal visual footprint */
.st{
  display:flex;align-items:center;gap:6px;
  padding:3px 10px 3px 14px;cursor:pointer;user-select:none;
  font-size:0.85em;
  border-top:1px solid var(--vscode-panel-border);
}
.pane-gha .st{padding:3px 14px 3px 10px}
.st:hover{background:var(--vscode-editor-hoverHighlightBackground,rgba(255,255,255,.04))}

.st-seq{font-size:.76em;opacity:.45;font-weight:400;flex-shrink:0}

/* Pill — only wraps the step name */
.st-pill{
  display:inline-block;
  font-weight:600;font-size:.82em;
  padding:1px 8px;border-radius:10px;border-width:1px;border-style:solid;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  max-width:60%;flex-shrink:1;min-width:0;
}

.st-badge{
  font-size:.70em;font-weight:700;padding:1px 6px;border-radius:8px;
  text-transform:uppercase;letter-spacing:.03em;flex-shrink:0;margin-left:auto;
}
.st-badge.mapped   {background:rgba(60,200,120,.20);color:#3cc878}
.st-badge.fallback {background:rgba(232,156,60,.20);color:#e89c3c}
.st-badge.manual_review{background:rgba(220,80,80,.20);color:#dc5050}

.col-btn{
  background:none;border:none;color:inherit;cursor:pointer;
  font-size:.80em;padding:0 2px;opacity:.45;transition:transform .15s;flex-shrink:0;
}
.col-btn.collapsed{transform:rotate(-90deg)}
.col-btn:hover{opacity:.9}

.sb-body{}
.sb-body.hidden{display:none}

/* Selected step — subtle outline on the title bar */
.sb.selected>.st{background:var(--vscode-editor-selectionHighlightBackground,rgba(255,255,255,.06))}

/* ── SVG connector overlay ────────────────────────────────────────── */
#conn-svg{
  position:absolute;top:0;left:0;width:100%;height:100%;
  pointer-events:none;overflow:visible;z-index:9;
}

/* ── Rationale panel ──────────────────────────────────────────────── */
.rat{
  flex-shrink:0;height:230px;min-height:150px;
  border-top:2px solid var(--vscode-panel-border);
  background:var(--vscode-sideBar-background,var(--vscode-editor-background));
  overflow-y:auto;padding:12px 18px;display:flex;flex-direction:column;gap:7px;
}
.rat.hidden{display:none}
.rat-placeholder{color:var(--vscode-descriptionForeground);font-style:italic;font-size:.88em}
.rat-title{font-weight:700;font-size:.95em}
.rat-badges{display:flex;gap:7px;flex-wrap:wrap;align-items:center}
.rat-grid{
  display:grid;grid-template-columns:auto 1fr;
  gap:3px 14px;font-size:.84em;
}
.rat-lbl{color:var(--vscode-descriptionForeground);font-weight:600;white-space:nowrap}
.rat-text{font-size:.88em;line-height:1.65;margin-top:2px;color:var(--vscode-foreground)}
code{
  font-family:var(--vscode-editor-font-family,monospace);
  background:var(--vscode-textBlockQuote-background);
  padding:1px 5px;border-radius:3px;font-size:.9em;
}
</style>
</head>
<body>

<!-- Header -->
<div class="hdr">
  <div class="hdr-info">
    <div class="hdr-title">${esc(meta.pipeline_name)}</div>
    <div class="hdr-sub">
      <span>${esc(meta.project)}</span> &nbsp;·&nbsp;
      <span>${esc(meta.generated_at)}</span> &nbsp;·&nbsp;
      ${cfExists
        ? `<a onclick="openFile(${JSON.stringify(meta.source_file)})">${esc(meta.source_file)}</a>`
        : `<span>${esc(meta.source_file)}</span>`}
      &nbsp;→&nbsp;
      ${ghaExists
        ? `<a onclick="openFile(${JSON.stringify(meta.target_workflow)})">${esc(meta.target_workflow)}</a>`
        : `<span>${esc(meta.target_workflow)}</span>`}
    </div>
  </div>
  <div class="hdr-stats">
    <span class="bdg bdg-mapped">${meta.stats.mapped} mapped</span>
    <span class="bdg bdg-fallback">${meta.stats.fallback} fallback</span>
    <span class="bdg bdg-manual">${meta.stats.manual_review} manual</span>
    <button class="edit-btn" id="topo-toggle-btn" onclick="toggleTopology()" title="Show authoring/execution topology for Codefresh and GitHub Actions">📐 Topology</button>
  </div>
</div>

<!-- Topology view (authoring plane / execution plane diagrams) — hidden by default -->
<div class="topo-view hidden" id="topo-view">
  ${cfTopoHtml}
  ${ghaTopoHtml}
</div>

<!-- Split view -->
<div class="split" id="split">
  <svg id="conn-svg"></svg>

  <!-- CF pane -->
  <div class="pane pane-cf" id="cf-pane">
    <div class="pane-hdr">
      <span>Codefresh</span>
      ${cfExists
        ? `<a onclick="openFile(${JSON.stringify(meta.source_file)})" title="${esc(meta.source_file)}">${esc(meta.source_file.split('/').pop() ?? meta.source_file)}</a>`
        : `<span>${esc(meta.source_file.split('/').pop() ?? '')}</span>`}
    </div>
    ${cfCtxHtml}
    <div class="pane-scroll" id="cf-scroll">
      <div class="pane-content" id="cf-content"></div>
    </div>
  </div>

  <!-- GHA pane -->
  <div class="pane pane-gha" id="gha-pane">
    <div class="pane-hdr">
      <span>GitHub Actions</span>
      ${ghaExists
        ? `<a onclick="openFile(${JSON.stringify(meta.target_workflow)})" title="${esc(meta.target_workflow)}">${esc(meta.target_workflow.split('/').pop() ?? meta.target_workflow)}</a>`
        : `<span>${esc(meta.target_workflow.split('/').pop() ?? '')}</span>`}
      <span class="hdr-spacer"></span>
      <span id="gha-view-actions" class="edit-actions">
        <button class="edit-btn learn" id="learn-rule-btn" onclick="learnRule()"
          ${latestEdit ? '' : 'disabled'}
          title="${latestEdit ? 'Ask the LLM to generalise your last manual edit into a reusable rule' : 'Edit and save a GHA step first'}">
          🧠 Learn Rule
        </button>
        <button class="edit-btn" onclick="enterEdit()">✎ Edit</button>
      </span>
      <span id="gha-edit-actions" class="edit-actions hidden">
        <button class="edit-btn save" onclick="saveEdit()">Save</button>
        <button class="edit-btn" onclick="cancelEdit()">Cancel</button>
      </span>
    </div>
    ${ghaCtxHtml}
    <div class="pane-scroll" id="gha-scroll">
      <div class="pane-content" id="gha-content"></div>
      <textarea class="pane-editor hidden" id="gha-editor" spellcheck="false" wrap="off"></textarea>
    </div>
  </div>
</div>

<!-- Rationale panel -->
<div class="rat" id="rat">
  <div class="rat-placeholder">Click any step to see its mapping rationale.</div>
</div>

<script>
const __d__ = ${safeJson};
const __vscode__ = acquireVsCodeApi();

// ── Colour palette ────────────────────────────────────────────────────
const STROKE = {
  mapped_high:   '#3cc878',
  mapped_medium: '#e6b43c',
  mapped_low:    '#e89c3c',
  fallback:      '#e89c3c',
  manual_review: '#dc5050',
};
// Pill border colours (medium opacity)
const PILL_BD = {
  mapped_high:   'rgba(60,200,120,.40)',
  mapped_medium: 'rgba(230,180,60,.40)',
  mapped_low:    'rgba(232,156,60,.45)',
  fallback:      'rgba(232,156,60,.45)',
  manual_review: 'rgba(220,80,80,.50)',
};
// Pill fill colours (very light)
const PILL_BG = {
  mapped_high:   'rgba(60,200,120,.10)',
  mapped_medium: 'rgba(230,180,60,.10)',
  mapped_low:    'rgba(232,156,60,.12)',
  fallback:      'rgba(232,156,60,.12)',
  manual_review: 'rgba(220,80,80,.14)',
};

function colorKey(m) {
  if (!m) return 'fallback';
  if (m.status === 'manual_review') return 'manual_review';
  if (m.status === 'fallback')      return 'fallback';
  return 'mapped_' + m.confidence;
}

// ── HTML helpers ──────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function highlight(raw) {
  if (/^\\s*#/.test(raw))
    return '<span class="yc">' + esc(raw) + '</span>';
  // "- name: ..." — highlight the name value in distinct colour
  const nm = raw.match(/^(\\s*)(- name:)(\\s*)(.*)$/);
  if (nm) return esc(nm[1]) + '<span class="yd">- </span><span class="yk">name:</span>' + esc(nm[3]) + '<span class="yn">' + esc(nm[4]) + '</span>';
  // list dash
  const li = raw.match(/^(\\s*)(- )(.*)/);
  if (li) return esc(li[1]) + '<span class="yd">- </span>' + esc(li[3]);
  // key: value
  const kv = raw.match(/^(\\s*)([\\w.$-]+)(:)(\\s?)(.*)/);
  if (kv) return esc(kv[1]) + '<span class="yk">' + esc(kv[2]) + '</span><span class="yk">:</span>' + esc(kv[4]) + '<span class="yv">' + esc(kv[5]) + '</span>';
  return esc(raw);
}

// ── Panel renderer ────────────────────────────────────────────────────
function renderPanel(side, yaml, ranges) {
  const lines = yaml.split('\\n');
  const seqMap = {};                          // line → seq
  for (const [seq, r] of Object.entries(ranges))
    for (let i = r.start; i <= r.end; i++) seqMap[i] = +seq;

  const bySeq = {};
  for (const m of __d__.mappings) bySeq[m.seq] = m;

  let html = '';
  let cur = null;   // current seq open

  for (let i = 0; i < lines.length; i++) {
    const seq = seqMap[i] ?? null;

    if (seq !== cur) {
      if (cur !== null) html += '</div></div>';   // close body + block
      cur = seq;
      if (seq !== null) {
        const m   = bySeq[seq];
        const ck  = colorKey(m);
        const col = STROKE[ck];
        const lbl = side === 'cf' ? (m?.cf_title ?? 'step ' + seq) : (m?.gha_step ?? 'step ' + seq);
        const st  = m?.status ?? '';
        html += '<div class="sb" id="' + side + '-sb-' + seq + '" data-seq="' + seq + '">';
        // Gutter mark — thin confidence bar on the outer edge of each pane
        html += '<div class="g-mark" style="background:' + col + '"></div>';
        // Compact title bar — no full-width background
        html += '<div class="st" id="' + side + '-st-' + seq + '" onclick="pick(' + seq + ')">';
        html += '<button class="col-btn collapsed" id="' + side + '-cb-' + seq + '" '
              + 'onclick="event.stopPropagation();fold(' + seq + ')" title="Collapse/expand">▾</button>';
        html += '<span class="st-seq">#' + seq + '</span>';
        // Pill: only wraps the step name
        html += '<span class="st-pill" style="color:' + col
              + ';background:' + PILL_BG[ck]
              + ';border-color:' + PILL_BD[ck] + '">' + esc(lbl) + '</span>';
        if (st) html += '<span class="st-badge ' + st + '">' + esc(st.replace('_',' ')) + '</span>';
        html += '</div>';   // end .st
        // Collapsed by default — body content is rendered but hidden until expanded
        html += '<div class="sb-body hidden" id="' + side + '-bd-' + seq + '">';
      }
    }

    html += '<div class="cl">' + highlight(lines[i]) + '</div>';
  }

  if (cur !== null) html += '</div></div>';
  document.getElementById(side + '-content').innerHTML = html;
}

// ── SVG connectors ─────────────────────────────────────────────────────
function draw() {
  const svg    = document.getElementById('conn-svg');
  const split  = document.getElementById('split');
  const wr     = split.getBoundingClientRect();
  const paths  = [];

  for (const m of __d__.mappings) {
    if (!__d__.cfRanges[m.seq] && !__d__.ghaRanges[m.seq]) continue;
    const cfEl  = document.getElementById('cf-st-'  + m.seq);
    const ghaEl = document.getElementById('gha-st-' + m.seq);
    if (!cfEl || !ghaEl) continue;

    const cr = cfEl.getBoundingClientRect();
    const gr = ghaEl.getBoundingClientRect();
    if (cr.height === 0 || gr.height === 0) continue;

    // CF and GHA panes scroll independently, and a step rarely spans the same
    // number of lines on both sides — requiring BOTH endpoints to be visible
    // at once meant the connector almost never showed. Instead, only drop it
    // when NEITHER side is in view; otherwise clamp the off-screen endpoint to
    // the nearest split edge so the line still points toward it.
    const cfVisible  = cr.bottom >= wr.top && cr.top <= wr.bottom;
    const ghaVisible = gr.bottom >= wr.top && gr.top <= wr.bottom;
    if (!cfVisible && !ghaVisible) continue;

    const clampY = y => Math.min(Math.max(y, wr.top), wr.bottom);

    const x1 = cr.right  - wr.left;
    const y1 = clampY(cr.top + cr.height / 2) - wr.top;
    const x2 = gr.left   - wr.left;
    const y2 = clampY(gr.top + gr.height / 2) - wr.top;

    const ck   = colorKey(m);
    const col  = STROKE[ck];
    const dx   = (x2 - x1) * 0.45;
    const both = cfVisible && ghaVisible;
    const dotOp  = both ? .85 : .3;
    const lineOp = both ? .6  : .25;

    paths.push('<circle cx="' + x1 + '" cy="' + y1 + '" r="3.5" fill="' + col + '" opacity="' + dotOp + '"/>');
    paths.push('<path d="M' + x1 + ',' + y1
             + ' C' + (x1+dx) + ',' + y1 + ' ' + (x2-dx) + ',' + y2 + ' ' + x2 + ',' + y2 + '"'
             + ' stroke="' + col + '" stroke-width="1.5" fill="none" opacity="' + lineOp + '"/>');
    paths.push('<circle cx="' + x2 + '" cy="' + y2 + '" r="3.5" fill="' + col + '" opacity="' + dotOp + '"/>');
  }

  svg.innerHTML = paths.join('');
}

// ── Interaction ───────────────────────────────────────────────────────
let sel = null;

function pick(seq) {
  if (sel !== null) {
    document.getElementById('cf-sb-'  + sel)?.classList.remove('selected');
    document.getElementById('gha-sb-' + sel)?.classList.remove('selected');
  }
  sel = seq;
  document.getElementById('cf-sb-'  + seq)?.classList.add('selected');
  document.getElementById('gha-sb-' + seq)?.classList.add('selected');
  showRat(seq);
  draw();
}

function fold(seq) {
  const bd = document.getElementById('cf-bd-' + seq) ?? document.getElementById('gha-bd-' + seq);
  const hidden = bd?.classList.contains('hidden') ?? false;
  ['cf','gha'].forEach(s => {
    document.getElementById(s + '-bd-' + seq)?.classList.toggle('hidden', !hidden);
    document.getElementById(s + '-cb-' + seq)?.classList.toggle('collapsed', !hidden);
  });
  setTimeout(draw, 60);
}

function showRat(seq) {
  const m   = __d__.mappings.find(x => x.seq === seq);
  const rat = document.getElementById('rat');
  if (!m) { rat.innerHTML = '<p class="rat-placeholder">No data.</p>'; return; }

  const col = STROKE[colorKey(m)];
  rat.innerHTML =
    '<div class="rat-title" style="color:' + col + '">#' + m.seq
      + ' &nbsp;—&nbsp; ' + esc(m.cf_title) + ' &nbsp;→&nbsp; ' + esc(m.gha_step) + '</div>'
    + '<div class="rat-badges">'
      + '<span class="st-badge ' + m.status + '">' + esc(m.status.replace('_',' ')) + '</span>'
      + '<span class="bdg bdg-' + (m.status==='mapped'?'mapped':m.status==='fallback'?'fallback':'manual') + '">'
        + esc(m.confidence) + ' confidence</span>'
    + '</div>'
    + '<div class="rat-grid">'
      + '<span class="rat-lbl">Rule</span><span><code>' + esc(m.rule_id) + '</code></span>'
      + '<span class="rat-lbl">Pattern</span><span>'
          + (m.pattern_matched ? '<code>' + esc(m.pattern_matched) + '</code>' : '<em style="opacity:.6">none</em>') + '</span>'
      + '<span class="rat-lbl">Action</span><span><code>' + esc(m.action) + '</code></span>'
      + '<span class="rat-lbl">CF step</span><span><code>' + esc(m.cf_step) + '</code>'
          + ' (' + esc(m.cf_type) + ', stage: ' + esc(m.cf_stage) + ')</span>'
      + '<span class="rat-lbl">GHA job</span><span><code>' + esc(m.gha_job) + '</code></span>'
    + '</div>'
    + '<div class="rat-text">' + esc(m.rationale) + '</div>';
}

function openFile(p) { __vscode__.postMessage({ type:'openFile', path:p }); }

function toggleCtx(side) {
  document.getElementById(side + '-ctx')?.classList.toggle('collapsed');
  setTimeout(draw, 60);
}

function toggleTopology() {
  const topo = document.getElementById('topo-view');
  const split = document.getElementById('split');
  const rat = document.getElementById('rat');
  const showingTopo = topo.classList.contains('hidden');
  topo.classList.toggle('hidden', !showingTopo);
  split.classList.toggle('hidden', showingTopo);
  rat.classList.toggle('hidden', showingTopo);
  document.getElementById('topo-toggle-btn').textContent = showingTopo ? '⬅ Back to Diff' : '📐 Topology';
  if (!showingTopo) setTimeout(draw, 60);
}

// ── GHA editing ───────────────────────────────────────────────────────────
// Plain-textarea edit mode for the suggested workflow — the structured,
// per-line highlighted view doesn't support free-form insert/delete of lines,
// so editing swaps it out for raw text and saves writes straight back to
// meta.target_workflow on disk via the extension host.
function enterEdit() {
  const editor = document.getElementById('gha-editor');
  editor.value = __d__.ghaYaml;
  document.getElementById('gha-content').classList.add('hidden');
  editor.classList.remove('hidden');
  document.getElementById('gha-view-actions').classList.add('hidden');
  document.getElementById('gha-edit-actions').classList.remove('hidden');
  editor.focus();
}

function cancelEdit() {
  document.getElementById('gha-editor').classList.add('hidden');
  document.getElementById('gha-content').classList.remove('hidden');
  document.getElementById('gha-edit-actions').classList.add('hidden');
  document.getElementById('gha-view-actions').classList.remove('hidden');
}

function saveEdit() {
  const content = document.getElementById('gha-editor').value;
  // 'sel' is the step currently picked (see pick(seq) above) — ties this edit to a
  // specific CF→GHA mapping so Learn Rule has something concrete to generalise from.
  __vscode__.postMessage({ type: 'saveGhaYaml', content, seq: sel });
}

function learnRule() {
  if (!__d__.latestEditId) return;
  __vscode__.postMessage({ type: 'learnRule', editId: __d__.latestEditId });
}

// ── Scroll alignment ─────────────────────────────────────────────────────
// One-directional: scrolling the CF (left) pane auto-scrolls GHA (right) so the
// step currently anchored at the top of the CF viewport sits at the same
// relative offset on the GHA side. GHA is never the driver, so there's no
// scroll-event feedback loop between the two panes.

// The step whose title bar is the last one at/above the container's own top
// edge — i.e. the step "in view" right now, same idea as scrollspy.
function topAnchor(scrollEl, side) {
  const seqs = Object.keys(__d__[side + 'Ranges']).map(Number).sort((a, b) => a - b);
  const top = scrollEl.getBoundingClientRect().top;
  let anchor = null;
  for (const seq of seqs) {
    const el = document.getElementById(side + '-st-' + seq);
    if (!el) continue;
    const offset = el.getBoundingClientRect().top - top;
    if (offset <= 0) { anchor = { seq, offset }; continue; }
    if (!anchor) anchor = { seq, offset };
    break;
  }
  return anchor;
}

// Closest seq to the given seq that actually has a rendered block on the given side.
function nearestSeqOn(side, seq) {
  const seqs = Object.keys(__d__[side + 'Ranges']).map(Number);
  if (!seqs.length) return null;
  return seqs.reduce((best, s) => Math.abs(s - seq) < Math.abs(best - seq) ? s : best, seqs[0]);
}

let aligning = false;
function alignRight() {
  if (aligning) return;
  const cfScroll  = document.getElementById('cf-scroll');
  const ghaScroll = document.getElementById('gha-scroll');
  const anchor = topAnchor(cfScroll, 'cf');
  if (!anchor) return;

  const ghaSeq = nearestSeqOn('gha', anchor.seq);
  if (ghaSeq === null) return;
  const ghaEl = document.getElementById('gha-st-' + ghaSeq);
  if (!ghaEl) return;

  const ghaTop    = ghaScroll.getBoundingClientRect().top;
  const ghaOffset = ghaEl.getBoundingClientRect().top - ghaTop;
  const delta     = ghaOffset - anchor.offset;
  if (Math.abs(delta) < 1) return;

  aligning = true;
  ghaScroll.scrollTop += delta;
  aligning = false;
}

// ── Init ──────────────────────────────────────────────────────────────
function init() {
  renderPanel('cf',  __d__.cfYaml,  __d__.cfRanges);
  renderPanel('gha', __d__.ghaYaml, __d__.ghaRanges);

  // Draw after layout settles
  requestAnimationFrame(() => requestAnimationFrame(draw));

  document.getElementById('cf-scroll').addEventListener('scroll', () => {
    alignRight();
    draw();
  }, {passive:true});
  document.getElementById('gha-scroll').addEventListener('scroll', draw, {passive:true});
  window.addEventListener('resize', draw);
}

init();
</script>
</body>
</html>`;
}

function esc(s: string | undefined | null): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
