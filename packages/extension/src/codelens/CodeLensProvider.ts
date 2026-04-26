// Surfaces CodeLens actions at the top of any detected Codefresh pipeline file:
//   ▶ Analyse · Plan · Generate · Open Approval

import * as vscode from 'vscode';

import type { ExtensionServices } from '../services/ExtensionServices';

export class CFMigrateCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly services: () => ExtensionServices | undefined) {}

  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!isCodefreshDocument(document)) return [];
    const s = this.services();
    const range = new vscode.Range(0, 0, 0, 0);

    const lenses: vscode.CodeLens[] = [];

    lenses.push(
      new vscode.CodeLens(range, {
        command: 'cf-migrate.setActivePipeline',
        title: '$(circle-filled) Set as active',
        arguments: [vscode.workspace.asRelativePath(document.uri)],
      }),
      new vscode.CodeLens(range, {
        command: 'cf-migrate.analyse',
        title: '$(microscope) Analyse',
      }),
    );

    if (s?.session.analysisResult) {
      lenses.push(
        new vscode.CodeLens(range, {
          command: 'cf-migrate.plan',
          title: '$(list-tree) Plan',
        }),
      );
    }

    if (s?.session.migrationPlan) {
      lenses.push(
        new vscode.CodeLens(range, {
          command: 'cf-migrate.openApproval',
          title: `$(check) Review (${pendingCount(s)} pending)`,
        }),
      );
      if (s.session.migrationPlan.approvalState.status === 'approved') {
        lenses.push(
          new vscode.CodeLens(range, {
            command: 'cf-migrate.generate',
            title: '$(rocket) Generate',
          }),
        );
      }
    }

    return lenses;
  }
}

function isCodefreshDocument(document: vscode.TextDocument): boolean {
  const lower = document.uri.fsPath.toLowerCase();
  if (
    lower.endsWith('/codefresh.yml') ||
    lower.endsWith('/codefresh.yaml') ||
    lower.endsWith('.cf.yml') ||
    lower.endsWith('.cf.yaml') ||
    lower.includes('/.codefresh/')
  ) {
    return true;
  }
  if (document.languageId !== 'yaml') return false;
  const head = document.getText(new vscode.Range(0, 0, 30, 0));
  return /\bversion:\s*['"]?1(\.0)?['"]?/.test(head) && /\bsteps:|stages:/.test(head);
}

function pendingCount(s: ExtensionServices): number {
  return s.session.migrationPlan?.items.filter((i) => i.status === 'pending').length ?? 0;
}
