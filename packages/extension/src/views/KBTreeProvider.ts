// Tree view of the loaded KB, grouped by type (snippet/pattern/template).
// Clicking a node opens the KB file in an editor tab.

import * as path from 'path';
import * as vscode from 'vscode';

import type { KBItem } from '@cf-migrate/core';

import type { ExtensionServices } from '../services/ExtensionServices';

type Node =
  | { kind: 'group'; type: 'snippet' | 'pattern' | 'template' }
  | { kind: 'item'; item: KBItem }
  | { kind: 'empty' };

export class KBTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private itemsByType = new Map<string, KBItem[]>();

  constructor(private readonly services: () => ExtensionServices | undefined) {}

  async refresh(): Promise<void> {
    const s = this.services();
    if (!s) {
      this.itemsByType.clear();
      this.emitter.fire(undefined);
      return;
    }
    try {
      const items = await s.agents.kbManager.list();
      this.itemsByType.clear();
      for (const item of items) {
        const arr = this.itemsByType.get(item.type) ?? [];
        arr.push(item);
        this.itemsByType.set(item.type, arr);
      }
    } catch {
      this.itemsByType.clear();
    }
    this.emitter.fire(undefined);
  }

  getTreeItem(element: Node): vscode.TreeItem {
    if (element.kind === 'empty') {
      const item = new vscode.TreeItem('Knowledge base not loaded.');
      item.description = 'Set cfMigrate.kbPath or install the bundled KB.';
      return item;
    }
    if (element.kind === 'group') {
      const count = this.itemsByType.get(element.type)?.length ?? 0;
      const item = new vscode.TreeItem(
        `${labelForType(element.type)} (${count})`,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.iconPath = new vscode.ThemeIcon(iconForType(element.type));
      return item;
    }
    const kb = element.item;
    const item = new vscode.TreeItem(kb.title, vscode.TreeItemCollapsibleState.None);
    item.description = `${kb.id} — used ${kb.usageCount}×`;
    item.tooltip = kb.description ?? kb.title;
    item.iconPath = new vscode.ThemeIcon(iconForType(kb.type));
    const services = this.services();
    if (services) {
      const file = path.join(services.kbStore.rootDir, `${kb.type}s`, `${kb.id}.md`);
      item.command = {
        command: 'vscode.open',
        title: 'Open',
        arguments: [vscode.Uri.file(file)],
      };
    }
    return item;
  }

  getChildren(element?: Node): Node[] {
    if (!this.services()) return [{ kind: 'empty' }];

    if (!element) {
      if (this.itemsByType.size === 0) return [{ kind: 'empty' }];
      return (['snippet', 'pattern', 'template'] as const).map<Node>((t) => ({
        kind: 'group',
        type: t,
      }));
    }

    if (element.kind === 'group') {
      const arr = this.itemsByType.get(element.type) ?? [];
      return [...arr]
        .sort((a, b) => a.title.localeCompare(b.title))
        .map<Node>((item) => ({ kind: 'item', item }));
    }

    return [];
  }
}

function labelForType(t: string): string {
  return t[0].toUpperCase() + t.slice(1) + 's';
}

function iconForType(t: string): string {
  switch (t) {
    case 'snippet':
      return 'code';
    case 'pattern':
      return 'type-hierarchy';
    case 'template':
      return 'file-code';
    default:
      return 'book';
  }
}
