import * as vscode from 'vscode';

import type { MapRunEntry } from '../scanners/MapRunScanner';
import { MapRunScanner } from '../scanners/MapRunScanner';
import { groupByTemplate, type TemplateGroup } from '../utils/TemplateGrouping';

type Node =
  | { kind: 'template-group'; group: TemplateGroup }
  | { kind: 'project'; project: string; entries: MapRunEntry[] }
  | { kind: 'entry'; entry: MapRunEntry }
  | { kind: 'instance'; entry: MapRunEntry; group: TemplateGroup }
  | { kind: 'empty' };

export class MapRunTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private groups: TemplateGroup[] = [];
  private standaloneByProject = new Map<string, MapRunEntry[]>();

  async refresh(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const entries = await MapRunScanner.scan(folders);

    // Template detection runs across the whole workspace, not per-project — the same
    // template is typically deployed once per environment, each living under its own CF
    // project (PROD/STAGING/DEV), so grouping must not be scoped to a single project.
    const { groups, standalone } = groupByTemplate(entries);
    this.groups = groups;

    this.standaloneByProject.clear();
    for (const entry of standalone) {
      const proj = entry.data.meta.project || '(unknown)';
      const arr = this.standaloneByProject.get(proj) ?? [];
      arr.push(entry);
      this.standaloneByProject.set(proj, arr);
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

    if (element.kind === 'template-group') {
      const { group } = element;
      const label = group.template.data.meta.pipeline_name.split('/').pop() ?? group.template.data.meta.pipeline_name;
      const item = new vscode.TreeItem(`Template: ${label}`, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon('layers');
      item.description = `${group.instances.length} instance${group.instances.length !== 1 ? 's' : ''}`;
      item.tooltip = [
        `Shared structure detected across ${1 + group.instances.length} pipelines.`,
        `Template: ${group.template.data.meta.pipeline_name}`,
        `Instances: ${group.instances.map((i) => i.data.meta.pipeline_name).join(', ')}`,
        'Mapping is defined once on the template — instances inherit it and only differ by variable values.',
      ].join('\n');
      item.contextValue = 'maprun-template-group';
      return item;
    }

    if (element.kind === 'instance') {
      const { meta } = element.entry.data;
      const item = new vscode.TreeItem(meta.pipeline_name, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('symbol-reference');
      item.description = `${meta.project} · instance`;
      item.tooltip = [
        meta.pipeline_name,
        `Instance of template: ${element.group.template.data.meta.pipeline_name}`,
        `Source: ${meta.source_file}`,
        'Mapping is inherited from the template — use "Generate Caller Workflows" on the template group to emit this instance’s reusable-workflow caller.',
      ].join('\n');
      item.contextValue = 'maprun-instance';
      item.command = {
        command: 'cf-migrate.explainInstance',
        title: 'Explain Template Instance',
        arguments: [element.entry, element.group],
      };
      return item;
    }

    // entry node (standalone, or the template representative within a group)
    const { meta } = element.entry.data;
    const isTemplateRoot = this.groups.some((g) => g.template.filePath === element.entry.filePath);
    const label = isTemplateRoot ? `${meta.pipeline_name} (template)` : meta.pipeline_name.split('/').pop() ?? meta.pipeline_name;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('list-tree');
    item.description = statsLabel(meta.stats.mapped, meta.stats.fallback, meta.stats.manual_review);
    item.tooltip = [
      meta.pipeline_name,
      `Source: ${meta.source_file}`,
      `Generated: ${meta.generated_at}`,
      `Steps: ${meta.total_steps}`,
      isTemplateRoot ? 'Only the template is mapped — instances inherit this mapping and only differ by variable values.' : '',
    ].filter(Boolean).join('\n');
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
      const projectNodes: Node[] = [...this.standaloneByProject.entries()].map(([project, entries]) => ({
        kind: 'project', project, entries,
      }));
      const groupNodes: Node[] = this.groups.map((group) => ({ kind: 'template-group', group }));
      const all = [...groupNodes, ...projectNodes];
      return all.length === 0 ? [{ kind: 'empty' }] : all;
    }

    if (element.kind === 'project') {
      return element.entries.map<Node>((entry) => ({ kind: 'entry', entry }));
    }

    if (element.kind === 'template-group') {
      return [
        { kind: 'entry', entry: element.group.template },
        ...element.group.instances.map<Node>((entry) => ({ kind: 'instance', entry, group: element.group })),
      ];
    }

    return [];
  }
}

function statsLabel(mapped: number, fallback: number, manual: number): string {
  return `${mapped}↗  ${fallback}⚠  ${manual}✗`;
}
