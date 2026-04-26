// Bottom-right status bar item showing migration phase / counts.

import * as vscode from 'vscode';

import type { ExtensionServices } from '../services/ExtensionServices';

export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor(private readonly services: () => ExtensionServices | undefined) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'cf-migrate.showReport';
    this.item.text = '$(run-all) CF Migrate';
    this.item.tooltip = 'Codefresh → GitHub Actions migration';
    this.item.show();
  }

  refresh(): void {
    const s = this.services();
    if (!s) {
      this.item.text = '$(run-all) CF Migrate — waiting for workspace';
      return;
    }
    const phase = s.session.phase;
    const pipelines = s.session.inventory?.pipelines.length ?? 0;
    const plan = s.session.migrationPlan;

    const modeTag = s.deterministicOnly ? ' ⚡ deterministic' : s.llmAvailable ? '' : ' ⚠ no LLM';

    let summary = `$(run-all) CF Migrate — ${phase}`;
    if (pipelines > 0) summary += ` · ${pipelines} pipeline${pipelines === 1 ? '' : 's'}`;
    if (plan) {
      summary += ` · ${plan.approvalState.approvedCount}/${plan.items.length} approved`;
    }
    this.item.text = summary + modeTag;
    this.item.tooltip = s.deterministicOnly
      ? 'CF Migrate — deterministic mode (no LLM calls)'
      : 'Codefresh → GitHub Actions migration';
  }

  dispose(): void {
    this.item.dispose();
  }
}
