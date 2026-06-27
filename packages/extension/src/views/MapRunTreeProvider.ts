import * as vscode from 'vscode';

import type { MapRunEntry } from '../scanners/MapRunScanner';
import { MapRunScanner } from '../scanners/MapRunScanner';

type Node =
  | { kind: 'project'; project: string; entries: MapRunEntry[] }
  | { kind: 'entry'; entry: MapRunEntry }
  | { kind: 'empty' };

export class MapRunTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private byProject = new Map<string, MapRunEntry[]>();

  async refresh(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const entries = await MapRunScanner.scan(folders);

    this.byProject.clear();
    for (const entry of entries) {
      const proj = entry.data.meta.project || '(unknown)';
      const arr = this.byProject.get(proj) ?? [];
      arr.push(entry);
      this.byProject.set(proj, arr);
    }

    this.emitter.fire(undefined);
  }

  getTreeItem(element: Node): vscode.TreeItem {
    if (element.kind === 'empty') {
      const item = new vscode.TreeItem('No .map.json files found in workspace.');
      item.iconPath = new vscode.ThemeIcon('info');
      return item;
    }

    if (element.kind === 'project') {
      const item = new vscode.TreeItem(
        element.project,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.iconPath = new vscode.ThemeIcon('folder');
      item.description = `${element.entries.length} pipeline${element.entries.length !== 1 ? 's' : ''}`;
      return item;
    }

    // entry node
    const { meta } = element.entry.data;
    const label = meta.pipeline_name.split('/').pop() ?? meta.pipeline_name;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('list-tree');
    item.description = statsLabel(meta.stats.mapped, meta.stats.fallback, meta.stats.manual_review);
    item.tooltip = [
      meta.pipeline_name,
      `Source: ${meta.source_file}`,
      `Generated: ${meta.generated_at}`,
      `Steps: ${meta.total_steps}`,
    ].join('\n');
    item.contextValue = 'maprun-entry';
    item.command = {
      command: 'cf-migrate.openMapRun',
      title: 'Open Map Run Diff',
      arguments: [element.entry],
    };
    return item;
  }

  getChildren(element?: Node): Node[] {
    if (!element) {
      if (this.byProject.size === 0) return [{ kind: 'empty' }];
      return [...this.byProject.entries()].map<Node>(([project, entries]) => ({
        kind: 'project',
        project,
        entries,
      }));
    }

    if (element.kind === 'project') {
      return element.entries.map<Node>((entry) => ({ kind: 'entry', entry }));
    }

    return [];
  }
}

function statsLabel(mapped: number, fallback: number, manual: number): string {
  return `${mapped}↗  ${fallback}⚠  ${manual}✗`;
}
