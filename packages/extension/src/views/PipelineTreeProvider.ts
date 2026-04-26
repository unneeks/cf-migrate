// Activity-bar tree view showing discovered Codefresh pipelines and their current phase.
//
// Layout:
//   Pipelines
//     ├─ codefresh.yml            [analysed ▶ planned]
//     │   ├─ Discovery: ok (4 pipelines)
//     │   ├─ Analysis: 23 constructs, complexity 0.62
//     │   ├─ Plan: 18 items (3 need review)
//     │   └─ Workflows: ci.yml, build.yml
//     └─ service-a.cf.yml         [discovered]
//
// Double-clicking a pipeline sets it as active; the per-phase rows are clickable and
// route to the relevant command.

import * as path from 'path';
import * as vscode from 'vscode';

import type { ExtensionServices } from '../services/ExtensionServices';

type Node =
  | { kind: 'pipeline'; relativePath: string }
  | { kind: 'phase'; parent: string; phase: string; label: string; command?: string }
  | { kind: 'empty' };

export class PipelineTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly services: () => ExtensionServices | undefined) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: Node): vscode.TreeItem {
    if (element.kind === 'empty') {
      const item = new vscode.TreeItem('No Codefresh pipelines discovered yet.');
      item.description = 'Run: CF Migrate — Discover Pipelines';
      item.command = {
        command: 'cf-migrate.discover',
        title: 'Discover',
      };
      return item;
    }
    if (element.kind === 'pipeline') {
      const s = this.services();
      const isActive = s?.session.activePipeline?.relativePath === element.relativePath;
      const item = new vscode.TreeItem(
        element.relativePath,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.contextValue = 'pipeline';
      item.iconPath = new vscode.ThemeIcon(isActive ? 'circle-filled' : 'file-code');
      item.description = isActive ? `active — ${s?.session.phase ?? 'idle'}` : undefined;
      item.tooltip = element.relativePath;
      item.command = {
        command: 'cf-migrate.setActivePipeline',
        title: 'Set Active',
        arguments: [element.relativePath],
      };
      return item;
    }
    const item = new vscode.TreeItem(element.label);
    item.iconPath = phaseIcon(element.phase);
    if (element.command) {
      item.command = { command: element.command, title: element.label };
    }
    return item;
  }

  getChildren(element?: Node): Node[] {
    const s = this.services();
    if (!s) return [{ kind: 'empty' }];

    if (!element) {
      const pipelines = s.session.inventory?.pipelines ?? [];
      if (pipelines.length === 0) return [{ kind: 'empty' }];
      return pipelines.map<Node>((p) => ({ kind: 'pipeline', relativePath: p.relativePath }));
    }

    if (element.kind !== 'pipeline') return [];

    const { session } = s;
    const active = session.activePipeline?.relativePath === element.relativePath;
    const children: Node[] = [];

    children.push({
      kind: 'phase',
      parent: element.relativePath,
      phase: 'discovered',
      label: `Discovery: ${session.inventory?.pipelines.length ?? 0} pipeline(s)`,
    });

    if (active && session.analysisResult) {
      const c = session.analysisResult;
      children.push({
        kind: 'phase',
        parent: element.relativePath,
        phase: 'analysed',
        label: `Analysis: ${c.constructs.length} constructs, complexity ${c.complexityScore.toFixed(2)}`,
      });
    } else if (active) {
      children.push({
        kind: 'phase',
        parent: element.relativePath,
        phase: 'pending',
        label: 'Analyse…',
        command: 'cf-migrate.analyse',
      });
    }

    if (active && session.migrationPlan) {
      const plan = session.migrationPlan;
      const review = plan.items.filter((i) => i.requiresReview).length;
      children.push({
        kind: 'phase',
        parent: element.relativePath,
        phase: 'planned',
        label: `Plan: ${plan.items.length} items (${review} need review) — ${plan.approvalState.status}`,
        command: 'cf-migrate.openApproval',
      });
    } else if (active && session.analysisResult) {
      children.push({
        kind: 'phase',
        parent: element.relativePath,
        phase: 'pending',
        label: 'Generate plan…',
        command: 'cf-migrate.plan',
      });
    }

    if (active && session.generationManifest) {
      const names = session.generationManifest.workflows.map((w) => w.filename).join(', ');
      children.push({
        kind: 'phase',
        parent: element.relativePath,
        phase: 'generated',
        label: `Workflows: ${names}`,
        command: 'cf-migrate.showReport',
      });
    } else if (active && session.migrationPlan?.approvalState.status === 'approved') {
      children.push({
        kind: 'phase',
        parent: element.relativePath,
        phase: 'pending',
        label: 'Generate workflows…',
        command: 'cf-migrate.generate',
      });
    }

    return children;
  }
}

function phaseIcon(phase: string): vscode.ThemeIcon {
  switch (phase) {
    case 'discovered':
      return new vscode.ThemeIcon('search');
    case 'analysed':
      return new vscode.ThemeIcon('microscope');
    case 'planned':
      return new vscode.ThemeIcon('list-tree');
    case 'generated':
      return new vscode.ThemeIcon('rocket');
    default:
      return new vscode.ThemeIcon('circle-large-outline');
  }
}
