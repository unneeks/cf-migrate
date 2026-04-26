// Plan approval webview.
//
// Lists every PlanItem with:
//   • confidence tier + badge (A / B / C)
//   • CF construct line range (click to jump)
//   • proposed GHA action/pattern + rationale
//   • KB snippet match (if any)
//   • per-item Approve / Reject / Modify buttons
//
// A header toolbar has Approve-All (only enabled if no items require review) and
// Reject-All. On approve the plan's approvalState flips to 'approved' which unlocks
// GenerationAgent.generate().

import * as vscode from 'vscode';

import type {
  MigrationPlan,
  PlanItem,
  PlanItemStatus,
} from '@cf-migrate/core';

import type { ExtensionServices } from '../services/ExtensionServices';

export class ApprovalPanel {
  private static current: ApprovalPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static show(
    context: vscode.ExtensionContext,
    services: ExtensionServices,
    onPlanChanged: () => void,
  ): void {
    if (ApprovalPanel.current) {
      ApprovalPanel.current.panel.reveal(vscode.ViewColumn.Active);
      ApprovalPanel.current.refresh();
      return;
    }
    const plan = services.session.migrationPlan;
    if (!plan) {
      void vscode.window.showWarningMessage(
        'No migration plan yet. Run CF Migrate: Generate Migration Plan first.',
      );
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'cf-migrate.approval',
      `Migration Plan Review — ${plan.pipelinePath}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    ApprovalPanel.current = new ApprovalPanel(panel, services, context, onPlanChanged);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly services: ExtensionServices,
    _context: vscode.ExtensionContext,
    private readonly onPlanChanged: () => void,
  ) {
    this.panel = panel;
    this.panel.webview.onDidReceiveMessage((m) => this.handleMessage(m), undefined, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    this.refresh();
  }

  private async handleMessage(msg: { type: string; [k: string]: unknown }): Promise<void> {
    const plan = this.services.session.migrationPlan;
    if (!plan) return;

    switch (msg.type) {
      case 'itemStatus': {
        const id = msg.id as string;
        const status = msg.status as PlanItemStatus;
        const reviewerNotes = (msg.notes as string) ?? undefined;
        const item = plan.items.find((i) => i.id === id);
        if (!item) return;
        item.status = status;
        item.reviewerNotes = reviewerNotes;
        item.reviewedBy = 'vscode-user';
        item.reviewedAt = new Date();
        if (status === 'approved-modified' && msg.modification) {
          item.proposedModification = msg.modification as string;
        }
        this.recomputeApproval(plan);
        await this.services.ledger.append(
          status === 'approved' || status === 'approved-modified'
            ? 'plan.item.approved'
            : status === 'rejected'
            ? 'plan.item.rejected'
            : 'plan.item.modified',
          { itemId: id, planId: plan.id, reviewerNotes, status },
        );
        this.onPlanChanged();
        this.refresh();
        break;
      }
      case 'approveAll': {
        for (const item of plan.items) {
          if (item.status === 'pending') item.status = 'approved';
        }
        this.recomputeApproval(plan);
        await this.services.ledger.append('plan.approved', { planId: plan.id });
        this.onPlanChanged();
        this.refresh();
        break;
      }
      case 'rejectAll': {
        plan.approvalState.status = 'rejected';
        plan.approvalState.rejectionReason = (msg.reason as string) ?? 'Rejected via review panel';
        await this.services.ledger.append('plan.rejected', {
          planId: plan.id,
          reason: plan.approvalState.rejectionReason,
        });
        this.onPlanChanged();
        this.refresh();
        break;
      }
      case 'jumpToLine': {
        const line = Number(msg.line) | 0;
        const active = this.services.session.activePipeline;
        if (!active) return;
        const doc = await vscode.workspace.openTextDocument(active.path);
        const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        const target = new vscode.Position(Math.max(0, line - 1), 0);
        editor.selection = new vscode.Selection(target, target);
        editor.revealRange(new vscode.Range(target, target), vscode.TextEditorRevealType.InCenter);
        break;
      }
    }
  }

  private recomputeApproval(plan: MigrationPlan): void {
    const approved = plan.items.filter(
      (i) => i.status === 'approved' || i.status === 'approved-modified',
    ).length;
    const pending = plan.items.filter((i) => i.status === 'pending').length;
    const rejected = plan.items.filter((i) => i.status === 'rejected').length;
    plan.approvalState.approvedCount = approved;
    plan.approvalState.pendingCount = pending;
    plan.approvalState.rejectedCount = rejected;
    if (pending === 0 && approved > 0 && rejected === 0) {
      plan.approvalState.status = 'approved';
      plan.approvalState.approvedAt = new Date();
      plan.approvalState.approvedBy = 'vscode-user';
    } else if (approved > 0 && pending > 0) {
      plan.approvalState.status = 'partially-approved';
    } else if (rejected > 0 && approved === 0 && pending === 0) {
      plan.approvalState.status = 'rejected';
    } else {
      plan.approvalState.status = 'pending';
    }
  }

  refresh(): void {
    const plan = this.services.session.migrationPlan;
    if (!plan) return;
    this.panel.webview.html = renderHtml(plan);
  }

  dispose(): void {
    ApprovalPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

function renderHtml(plan: MigrationPlan): string {
  const state = plan.approvalState;
  const allResolved = state.pendingCount === 0;
  const items = [...plan.items].sort((a, b) => a.sequenceNumber - b.sequenceNumber);

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }
  header { display: flex; align-items: center; gap: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 16px; }
  .status { padding: 2px 10px; border-radius: 10px; font-weight: 600; }
  .status.approved { background: rgba(60,200,120,0.2); color: #3cc878; }
  .status.pending { background: rgba(230,180,60,0.2); color: #e6b43c; }
  .status.rejected { background: rgba(220,80,80,0.2); color: #dc5050; }
  .status.partially-approved { background: rgba(100,160,220,0.2); color: #64a0dc; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 3px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); }
  button[disabled] { opacity: 0.5; cursor: not-allowed; }
  .item { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 12px 14px; margin-bottom: 10px; }
  .item.tier-A { border-left: 4px solid #3cc878; }
  .item.tier-B { border-left: 4px solid #e6b43c; }
  .item.tier-C { border-left: 4px solid #dc5050; }
  .item.approved { background: rgba(60,200,120,0.06); }
  .item.rejected { opacity: 0.5; }
  .row { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  .actions { display: flex; gap: 6px; margin-top: 8px; }
  .construct { font-family: var(--vscode-editor-font-family); background: var(--vscode-textBlockQuote-background); padding: 4px 6px; border-radius: 3px; }
  a.line-link { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; }
  .rationale { margin-top: 6px; color: var(--vscode-descriptionForeground); }
  .notes { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px; margin-top: 6px; font-family: inherit; }
</style>
</head>
<body>
<header>
  <h2 style="margin:0">Migration Plan Review</h2>
  <span class="status ${state.status}">${state.status}</span>
  <span class="meta">${state.approvedCount} approved · ${state.pendingCount} pending · ${state.rejectedCount} rejected · ${plan.items.length} total</span>
  <span style="flex:1"></span>
  <button onclick="approveAll()" ${allResolved && state.status === 'approved' ? 'disabled' : ''}>$(check) Approve all</button>
  <button class="secondary" onclick="rejectAll()">Reject plan</button>
</header>

${items.map(renderItem).join('\n')}

<script>
  const vscode = acquireVsCodeApi();
  function setStatus(id, status) {
    const notes = document.getElementById('notes-' + id)?.value ?? '';
    vscode.postMessage({ type: 'itemStatus', id, status, notes });
  }
  function approveAll() { vscode.postMessage({ type: 'approveAll' }); }
  function rejectAll() {
    const reason = prompt('Rejection reason?') ?? 'No reason given';
    vscode.postMessage({ type: 'rejectAll', reason });
  }
  function jumpToLine(line) { vscode.postMessage({ type: 'jumpToLine', line }); }
</script>
</body>
</html>`;
}

function renderItem(item: PlanItem): string {
  const tier = `tier-${item.confidenceTier}`;
  const statusClass = item.status === 'approved' || item.status === 'approved-modified'
    ? 'approved'
    : item.status === 'rejected'
    ? 'rejected'
    : '';
  return /* html */ `
  <div class="item ${tier} ${statusClass}">
    <div class="row">
      <div>
        <div><strong>#${item.sequenceNumber}</strong> — ${escapeHtml(item.ghaRecommendation.actionOrPattern)}
          <span class="meta">(tier ${item.confidenceTier}, ${item.complexity})</span>
        </div>
        <div class="meta">
          CF: <span class="construct">${escapeHtml(item.cfConstructRef.constructType)}</span>
          ${item.cfConstructRef.constructName ? ` — <span class="construct">${escapeHtml(item.cfConstructRef.constructName)}</span>` : ''}
          — <a class="line-link" onclick="jumpToLine(${item.cfConstructRef.lineStart})">line ${item.cfConstructRef.lineStart}</a>
          ${item.targetWorkflow ? ` → <code>${escapeHtml(item.targetWorkflow)}</code>` : ''}
        </div>
        <div>${escapeHtml(item.ghaRecommendation.description)}</div>
        <div class="rationale">${escapeHtml(item.rationale)}</div>
        ${item.kbSnippetId ? `<div class="meta">KB snippet: <code>${escapeHtml(item.kbSnippetId)}</code></div>` : ''}
        ${item.requiresReview ? `<div class="meta" style="color: #e6b43c">⚠️ flagged for human review</div>` : ''}
        <textarea id="notes-${item.id}" class="notes" placeholder="Reviewer notes (optional)…">${escapeHtml(item.reviewerNotes ?? '')}</textarea>
      </div>
      <div class="actions">
        <button onclick="setStatus('${item.id}', 'approved')">Approve</button>
        <button class="secondary" onclick="setStatus('${item.id}', 'rejected')">Reject</button>
      </div>
    </div>
  </div>`;
}

function escapeHtml(s: string | undefined): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
