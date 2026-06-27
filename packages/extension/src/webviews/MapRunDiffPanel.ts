import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

import type { MapRunFile, MapRunMapping } from '@cf-migrate/core';

import type { MapRunEntry } from '../scanners/MapRunScanner';

export class MapRunDiffPanel {
  private static readonly panels = new Map<string, MapRunDiffPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static async show(context: vscode.ExtensionContext, entry: MapRunEntry): Promise<void> {
    const key = entry.filePath;

    const existing = MapRunDiffPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const pipelineName = entry.data.meta.pipeline_name;
    const panel = vscode.window.createWebviewPanel(
      'cf-migrate.mapRunDiff',
      `Map Run — ${pipelineName}`,
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
      (msg: { type: string; [k: string]: unknown }) => void this.handleMessage(msg),
      undefined,
      this.disposables,
    );

    void this.render();
  }

  private async handleMessage(msg: { type: string; [k: string]: unknown }): Promise<void> {
    if (msg.type === 'openFile') {
      const rel = msg.path as string;
      const fullPath = path.resolve(this.entry.workspaceFolder.uri.fsPath, rel);
      try {
        await fs.access(fullPath);
        const doc = await vscode.workspace.openTextDocument(fullPath);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      } catch {
        void vscode.window.showWarningMessage(`File not found in workspace: ${rel}`);
      }
    }
  }

  private async render(): Promise<void> {
    const { data, workspaceFolder } = this.entry;
    const sourceExists = await fileExistsInWorkspace(workspaceFolder, data.meta.source_file);
    const targetExists = await fileExistsInWorkspace(workspaceFolder, data.meta.target_workflow);
    this.panel.webview.html = renderHtml(data, sourceExists, targetExists);
  }

  private dispose(): void {
    MapRunDiffPanel.panels.delete(this.entry.filePath);
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

async function fileExistsInWorkspace(
  folder: vscode.WorkspaceFolder,
  rel: string,
): Promise<boolean> {
  if (!rel) return false;
  try {
    await fs.access(path.resolve(folder.uri.fsPath, rel));
    return true;
  } catch {
    return false;
  }
}

// ── HTML rendering ────────────────────────────────────────────────────────────

function renderHtml(data: MapRunFile, sourceExists: boolean, targetExists: boolean): string {
  const { meta, mappings } = data;
  const sorted = [...mappings].sort((a, b) => a.seq - b.seq);

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0;
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }

  /* ── Header ─────────────────────────────────────────────────────── */
  .header {
    padding: 10px 16px;
    border-bottom: 1px solid var(--vscode-panel-border);
    display: flex;
    align-items: flex-start;
    gap: 16px;
    flex-shrink: 0;
  }
  .header-title { flex: 1; }
  .header-title h2 { margin: 0 0 2px; font-size: 1em; font-weight: 600; }
  .header-sub {
    font-size: 0.82em;
    color: var(--vscode-descriptionForeground);
  }
  .header-sub a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; }
  .stat-group { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 0.8em;
    font-weight: 600;
    white-space: nowrap;
  }
  .badge.mapped    { background: rgba(60,200,120,0.18); color: #3cc878; }
  .badge.fallback  { background: rgba(232,156,60,0.18); color: #e89c3c; }
  .badge.manual    { background: rgba(220,80,80,0.18);  color: #dc5050; }

  /* ── Split table ─────────────────────────────────────────────────── */
  .split-scroll {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
  }
  colgroup col:nth-child(1) { width: 44%; }
  colgroup col:nth-child(2) { width: 12%; }
  colgroup col:nth-child(3) { width: 44%; }

  thead th {
    position: sticky;
    top: 0;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    padding: 6px 12px;
    font-weight: 600;
    font-size: 0.85em;
    text-align: left;
    border-bottom: 1px solid var(--vscode-panel-border);
    z-index: 1;
  }
  thead th.center { text-align: center; }

  /* ── Stage / job group headers ───────────────────────────────────── */
  tr.group-header td {
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    padding: 4px 12px;
    font-size: 0.78em;
    font-weight: 600;
    color: var(--vscode-descriptionForeground);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    border-top: 1px solid var(--vscode-panel-border);
  }

  /* ── Mapping rows ────────────────────────────────────────────────── */
  tr.mapping {
    cursor: pointer;
    border-left: 3px solid transparent;
    transition: background 0.1s;
  }
  tr.mapping:hover td { background: var(--vscode-list-hoverBackground); }
  tr.mapping.selected td { background: var(--vscode-list-activeSelectionBackground) !important; color: var(--vscode-list-activeSelectionForeground); }

  tr.conf-high    { border-left-color: #3cc878; }
  tr.conf-medium  { border-left-color: #e6b43c; }
  tr.conf-low     { border-left-color: #e89c3c; }
  tr.conf-fallback { border-left-color: #e89c3c; }
  tr.conf-manual  { border-left-color: #dc5050; }

  tr.bg-fallback td { background: rgba(232,156,60,0.05); }
  tr.bg-manual   td { background: rgba(220,80,80,0.10); }

  td {
    padding: 7px 12px;
    vertical-align: top;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  td.center { text-align: center; vertical-align: middle; }

  .step-title { font-weight: 600; font-size: 0.9em; }
  .step-meta  { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  .pill {
    display: inline-block;
    padding: 1px 7px;
    border-radius: 8px;
    font-size: 0.75em;
    font-weight: 600;
    margin-right: 4px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  .conn { font-size: 1.1em; }
  .conn.ok   { color: #3cc878; }
  .conn.warn { color: #e89c3c; }
  .conn.bad  { color: #dc5050; }

  /* ── Rationale panel ─────────────────────────────────────────────── */
  .rationale-panel {
    flex-shrink: 0;
    border-top: 2px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    padding: 10px 16px;
    min-height: 100px;
    max-height: 200px;
    overflow-y: auto;
  }
  .rationale-panel .rp-placeholder {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
    font-size: 0.88em;
  }
  .rp-title {
    font-weight: 600;
    margin-bottom: 4px;
    font-size: 0.9em;
  }
  .rp-meta {
    font-size: 0.8em;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 6px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .rp-text {
    font-size: 0.88em;
    line-height: 1.5;
  }
  code {
    font-family: var(--vscode-editor-font-family);
    background: var(--vscode-textBlockQuote-background);
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 0.9em;
  }
</style>
</head>
<body>

<div class="header">
  <div class="header-title">
    <h2>${escapeHtml(meta.pipeline_name)}</h2>
    <div class="header-sub">
      <span>${escapeHtml(meta.project)}</span>
      &nbsp;·&nbsp;
      <span>Generated ${escapeHtml(meta.generated_at)}</span>
      &nbsp;·&nbsp;
      ${sourceExists
        ? `<a onclick="openFile(${JSON.stringify(meta.source_file)})">${escapeHtml(meta.source_file)}</a>`
        : `<span>${escapeHtml(meta.source_file)}</span>`}
      &nbsp;→&nbsp;
      ${targetExists
        ? `<a onclick="openFile(${JSON.stringify(meta.target_workflow)})">${escapeHtml(meta.target_workflow)}</a>`
        : `<span>${escapeHtml(meta.target_workflow)}</span>`}
    </div>
  </div>
  <div class="stat-group">
    <span class="badge mapped">${meta.stats.mapped} mapped</span>
    <span class="badge fallback">${meta.stats.fallback} fallback</span>
    <span class="badge manual">${meta.stats.manual_review} manual</span>
  </div>
</div>

<div class="split-scroll">
<table>
  <colgroup>
    <col /><col /><col />
  </colgroup>
  <thead>
    <tr>
      <th>Codefresh</th>
      <th class="center"></th>
      <th>GitHub Actions</th>
    </tr>
  </thead>
  <tbody id="tbody">
    ${renderRows(sorted)}
  </tbody>
</table>
</div>

<div class="rationale-panel" id="rationale-panel">
  <div class="rp-placeholder">Click any step row to see its mapping rationale.</div>
</div>

<script>
const vscode = acquireVsCodeApi();

const mappings = ${JSON.stringify(sorted)};

function openFile(p) {
  vscode.postMessage({ type: 'openFile', path: p });
}

function selectRow(seq) {
  document.querySelectorAll('tr.mapping').forEach(r => r.classList.remove('selected'));
  const row = document.getElementById('row-' + seq);
  if (row) row.classList.add('selected');

  const m = mappings.find(x => x.seq === seq);
  if (!m) return;

  const panel = document.getElementById('rationale-panel');
  const confLabel = m.status === 'manual_review' ? 'manual review'
    : m.status === 'fallback' ? 'fallback · ' + m.confidence
    : 'mapped · ' + m.confidence;

  panel.innerHTML =
    '<div class="rp-title">#' + m.seq + ' — ' + esc(m.cf_title) + ' → ' + esc(m.gha_step) + '</div>' +
    '<div class="rp-meta">' +
      '<span><strong>Status:</strong> ' + esc(m.status) + '</span>' +
      '<span><strong>Confidence:</strong> ' + esc(confLabel) + '</span>' +
      '<span><strong>Rule:</strong> <code>' + esc(m.rule_id) + '</code></span>' +
      (m.pattern_matched ? '<span><strong>Pattern:</strong> <code>' + esc(m.pattern_matched) + '</code></span>' : '') +
    '</div>' +
    '<div class="rp-text">' + esc(m.rationale) + '</div>';
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
</script>
</body>
</html>`;
}

function renderRows(mappings: MapRunMapping[]): string {
  const rows: string[] = [];
  let lastStage = '';
  let lastJob = '';

  for (const m of mappings) {
    const stageChanged = m.cf_stage !== lastStage || m.gha_job !== lastJob;
    if (stageChanged) {
      lastStage = m.cf_stage;
      lastJob = m.gha_job;
      rows.push(/* html */ `
      <tr class="group-header">
        <td>${escapeHtml(m.cf_stage)}</td>
        <td></td>
        <td>${escapeHtml(m.gha_job)}</td>
      </tr>`);
    }

    const { rowClass, connHtml } = rowMeta(m);

    rows.push(/* html */ `
    <tr id="row-${m.seq}" class="mapping ${rowClass}" onclick="selectRow(${m.seq})">
      <td>
        <span class="pill">${escapeHtml(m.cf_type)}</span>
        <span class="step-title">${escapeHtml(m.cf_title)}</span>
        <div class="step-meta">${escapeHtml(m.cf_step)}</div>
      </td>
      <td class="center">
        <span class="conn">${connHtml}</span>
      </td>
      <td>
        <span class="step-title">${escapeHtml(m.gha_step)}</span>
        <div class="step-meta">${escapeHtml(m.action)}</div>
      </td>
    </tr>`);
  }

  return rows.join('\n');
}

interface RowMeta { rowClass: string; connHtml: string }

function rowMeta(m: MapRunMapping): RowMeta {
  if (m.status === 'manual_review') {
    return { rowClass: 'conf-manual bg-manual', connHtml: '<span class="bad">✗</span>' };
  }
  if (m.status === 'fallback') {
    return { rowClass: 'conf-fallback bg-fallback', connHtml: '<span class="warn">⚠</span>' };
  }
  // mapped
  const confClass = m.confidence === 'high'
    ? 'conf-high'
    : m.confidence === 'medium'
    ? 'conf-medium'
    : 'conf-low';
  return { rowClass: confClass, connHtml: '<span class="ok">→</span>' };
}

function escapeHtml(s: string | undefined | null): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
