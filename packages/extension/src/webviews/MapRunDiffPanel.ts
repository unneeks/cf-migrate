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

import type { MapRunFile, MapRunMapping } from '@cf-migrate/core';

import type { MapRunEntry } from '../scanners/MapRunScanner';

interface StepRange { start: number; end: number }

export class MapRunDiffPanel {
  private static readonly panels = new Map<string, MapRunDiffPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static async show(context: vscode.ExtensionContext, entry: MapRunEntry): Promise<void> {
    const existing = MapRunDiffPanel.panels.get(entry.filePath);
    if (existing) { existing.panel.reveal(vscode.ViewColumn.Active); return; }
    const panel = vscode.window.createWebviewPanel(
      'cf-migrate.mapRunDiff',
      `Map Run — ${entry.data.meta.pipeline_name}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    new MapRunDiffPanel(panel, entry, context);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly entry: MapRunEntry,
    _context: vscode.ExtensionContext,
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
    }
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

    this.panel.webview.html = buildHtml(data, cfYaml, ghaYaml, cfRanges, ghaRanges, cfExists, ghaExists);
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

function parseGHARanges(yaml: string, mappings: MapRunMapping[]): Record<number, StepRange> {
  const lines = yaml.split('\n');
  const result: Record<number, StepRange> = {};

  const found: { name: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s+- name:\s+(.+)$/);
    if (m) found.push({ name: m[1].trim(), line: i });
  }

  for (let j = 0; j < found.length; j++) {
    const end = j + 1 < found.length ? found[j + 1].line - 1 : lines.length - 1;
    const mapping = mappings.find(m => m.gha_step === found[j].name);
    if (mapping) result[mapping.seq] = { start: found[j].line, end };
  }
  return result;
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
  }).replace(/<\/script>/gi, '<\\/script>');

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

/* ── Split view ───────────────────────────────────────────────────── */
.split{flex:1;display:flex;overflow:hidden;position:relative}

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

.pane-scroll{flex:1;overflow:auto}

.pane-content{
  font-family:var(--vscode-editor-font-family,monospace);
  font-size:0.85em;line-height:1.5;
  padding:6px 0;
}

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
  </div>
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
    </div>
    <div class="pane-scroll" id="gha-scroll">
      <div class="pane-content" id="gha-content"></div>
    </div>
  </div>
</div>

<!-- Rationale panel -->
<div class="rat" id="rat">
  <div class="rat-placeholder">Click any step to see its mapping rationale.</div>
</div>

<script>
const __d__ = ${safeJson};

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
        html += '<button class="col-btn" id="' + side + '-cb-' + seq + '" '
              + 'onclick="event.stopPropagation();fold(' + seq + ')" title="Collapse/expand">▾</button>';
        html += '<span class="st-seq">#' + seq + '</span>';
        // Pill: only wraps the step name
        html += '<span class="st-pill" style="color:' + col
              + ';background:' + PILL_BG[ck]
              + ';border-color:' + PILL_BD[ck] + '">' + esc(lbl) + '</span>';
        if (st) html += '<span class="st-badge ' + st + '">' + esc(st.replace('_',' ')) + '</span>';
        html += '</div>';   // end .st
        html += '<div class="sb-body" id="' + side + '-bd-' + seq + '">';
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

    // Clip to visible split area
    if (cr.bottom  < wr.top || cr.top  > wr.bottom) continue;
    if (gr.bottom  < wr.top || gr.top  > wr.bottom) continue;

    const x1 = cr.right  - wr.left;
    const y1 = cr.top + cr.height / 2 - wr.top;
    const x2 = gr.left   - wr.left;
    const y2 = gr.top + gr.height / 2 - wr.top;

    const ck  = colorKey(m);
    const col = STROKE[ck];
    const dx  = (x2 - x1) * 0.45;

    paths.push('<circle cx="' + x1 + '" cy="' + y1 + '" r="3.5" fill="' + col + '" opacity=".85"/>');
    paths.push('<path d="M' + x1 + ',' + y1
             + ' C' + (x1+dx) + ',' + y1 + ' ' + (x2-dx) + ',' + y2 + ' ' + x2 + ',' + y2 + '"'
             + ' stroke="' + col + '" stroke-width="1.5" fill="none" opacity=".6"/>');
    paths.push('<circle cx="' + x2 + '" cy="' + y2 + '" r="3.5" fill="' + col + '" opacity=".85"/>');
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

function openFile(p) { acquireVsCodeApi().postMessage({ type:'openFile', path:p }); }

// ── Init ──────────────────────────────────────────────────────────────
function init() {
  renderPanel('cf',  __d__.cfYaml,  __d__.cfRanges);
  renderPanel('gha', __d__.ghaYaml, __d__.ghaRanges);

  // Draw after layout settles
  requestAnimationFrame(() => requestAnimationFrame(draw));

  document.getElementById('cf-scroll') .addEventListener('scroll', draw, {passive:true});
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
